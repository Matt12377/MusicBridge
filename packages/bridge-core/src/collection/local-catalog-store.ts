import { LOCAL_LYRICS_ROOT_OPERATION, emptyLocalLyricsRootProjection, copyLocalLyricsRootProjection, assertLocalLyricsRootComplete, captureLocalLyricsRootRecord, assertLocalLyricsRootTransition, createLocalLyricsRootEvents, localLyricsRootLedgerRow, readLocalLyricsRootEvent, projectLocalLyricsRootEvent, type LocalLyricsRootProjection, type LocalLyricsRootRecord, type LocalLyricsRootRecordKind, type LocalLyricsRootRecordMap } from './local-library-workbench/owner-journal.js';
import { LOCAL_LIBRARY_MANAGEMENT_OPERATION, captureLocalLibraryManagementRecord, captureLocalLibraryManagementOwnerRecord, localLibraryManagementDigest,
  emptyLocalLibraryManagementProjection, copyLocalLibraryManagementProjection, assertLocalLibraryManagementComplete,
  readLocalLibraryManagementEvent, projectLocalLibraryManagementEvent, createLocalLibraryManagementBatchEvents, createLocalLibraryManagementRootRelinkEvents, localLibraryManagementLedgerRow,
  assertLocalLibraryManagementBatch, type LocalLibraryManagementProjection, type LocalLibraryManagementRecord,
  type LocalLibraryManagementRecordKind, type LocalLibraryManagementRecordMap, type LocalLibraryManagementStored,
  type LocalLibraryManagementWrite, type LocalLibraryManagementBindingRecord, type LocalLibraryManagementCaptureRecord, type LocalLibraryManagementCapturedAlbum,
  type LocalLibraryManagementJobRecord, type LocalLibraryManagementOperationRecord, type LocalLibraryManagementRootRelinkProof } from './local-library-workbench/owner-journal.js';
import { isLocalWorkbenchDenseArray, LocalWorkbenchPlanError } from './local-library-workbench/types.js';
import { applyLocalWorkbenchArtworkInTransaction, verifyLocalArtworkDatabase, pruneLocalLibraryArtworkCacheInTransaction } from './local-artwork-store.js';
import { LOCAL_LYRICS_PHYSICAL_OPERATION, captureLocalLyricsPhysicalRecord, localLyricsPhysicalOperationId,
  lyricsPhysicalCanonical, lyricsPhysicalDigest, type LocalLyricsPhysicalRecord, type LocalLyricsPhysicalStored } from '../library/lyrics-source-format.js';
import { emptyLocalLyricsPhysicalProjection, copyLocalLyricsPhysicalProjection, readLocalLyricsPhysicalEvent,
  projectLocalLyricsPhysicalEvent, assertLocalLyricsPhysicalComplete, createLocalLyricsPhysicalEvents, localLyricsPhysicalLedgerRow,
  type LocalLyricsPhysicalProjection, type LocalLyricsPhysicalPublication, type LocalLyricsInventoryRecord } from './local-library-workbench/owner-journal.js';
import { assertLocalWorkbenchCapturedPlan } from './local-library-workbench/plan-registry.js';
import type { LocalWorkbenchPlanCapture, LocalWorkbenchNameSource } from './local-library-workbench/types.js';
import type { LocalWorkbenchResolvedReadCapture } from './local-library-workbench/read-service.js';
import { localWorkbenchJournalCanonical, LOCAL_WORKBENCH_MB_ONLY_OPERATION, emptyLocalWorkbenchMBOnlyProjection, copyLocalWorkbenchMBOnlyProjection,
  readLocalWorkbenchMBOnlyEvent, projectLocalWorkbenchMBOnlyEvent, assertLocalWorkbenchMBOnlyComplete, createLocalWorkbenchMBOnlyEvents, localWorkbenchMBOnlyLedgerRow,
  type LocalWorkbenchMBOnlyRecord, type LocalWorkbenchMBOnlyProjection, type LocalWorkbenchMBNameSources } from './local-library-workbench/owner-journal.js';
import { LOCAL_CUE_OUTPUT_OPERATION, isLocalCueOutputRecord, createLocalCueOutputEvents, type LocalCueOutputRecord } from './local-cue-output-protocol.js';
import { LOCAL_SCAN_SETTINGS_OPERATION, isLocalScanSettingsEvent, type LocalScanSettingsStore, type LocalScanSettingsEvent, type LocalScanSettings, type LocalScanFrozenSettings } from './local-scan-settings.js';
import { emptyLocalCueOwnerProjection, copyLocalCueOwnerProjection, readLocalCueOwnerEvent, projectLocalCueOwnerEvent, assertLocalCueOwnerComplete, localCueOwnerLedgerRow,
  emptyLocalScanSettingsOwnerProjection, copyLocalScanSettingsOwnerProjection, readLocalScanSettingsOwnerEvent, projectLocalScanSettingsOwnerEvent, localScanSettingsOwnerOriginal, localScanSettingsOwnerLedgerRow,
  type LocalCueOwnerProjection, type LocalScanSettingsOwnerProjection } from './local-library-workbench/owner-journal.js';
import { assertLocalLyricsSaveRecord } from './local-library-lyrics/save-coordinator.js';
import type { DatasetIdentity } from '../recording/dataset-identity.js';
import { LocalLyricsError, lyricsCanonical, lyricsDigest, type LocalLyricsJobRecord, type LocalLyricsSaveRecord } from './local-library-lyrics/types.js';
import {
  LOCAL_WORKBENCH_JOURNAL_OPERATION, emptyLocalWorkbenchJournalProjection, copyLocalWorkbenchJournalProjection,
  readLocalWorkbenchJournalEvent, projectLocalWorkbenchJournalEvent, assertLocalWorkbenchJournalComplete, localWorkbenchJournalLedgerRow,
  LOCAL_LYRICS_JOURNAL_OPERATION, emptyLocalLyricsJournalProjection, readLocalLyricsJournalEvent, projectLocalLyricsJournalEvent,
  assertLocalLyricsJournalComplete, createLocalLyricsRecordEvents, createLocalLyricsStateEvents, localLyricsJournalLedgerRow, localLyricsRecordIdentity,
  type LocalWorkbenchJournalProjection, type LocalWorkbenchJournalEvent, type LocalLyricsJournalProjection,
  type LocalLyricsRecordKind, type LocalLyricsDurableRecord, type LocalLyricsRecordIndex, type LocalLyricsFullRecordPin,
} from './local-library-workbench/owner-journal.js';
import { commitLocalFacts, rollbackLocalFacts, LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { createHash, randomUUID } from 'node:crypto';
import { logLibraryOperation } from '../shared/library-operation-log.js';
import { albumCatalogRevision, albumScanRevision } from './local-album-browser/owner-store.js';
import { approveLocalAlbumScanDelta, invalidateLocalAlbumScanDelta, discardLocalAlbumScanDelta, localAlbumScanPoint, captureLocalAlbumCaptureWrite, type LocalAlbumCaptureWrite, type LocalAlbumScanDelta } from './local-album-browser/scan-delta.js';
import { createLocalAlbumMobileStructureSqlReader, createLocalAlbumSqlReader, createLocalAlbumSqlObservationHistory, continueReadonlyQueueObservationHistory, isCurrentLocalAlbumSqlReader, localAlbumSqlScopeFingerprint, readWithLocalAlbumSqlErrors, localAlbumOrganizationDirectoryBoundaries } from './local-album-browser/sql-read.js';
import type { LocalAlbumSqlScope, LocalAlbumLyricsInventory, LocalAlbumLibraryOrganization, LocalAlbumSqlIssueReadOptions, LocalAlbumSqlMobileQuery, LocalAlbumSqlMobilePage, LocalAlbumSqlObservationHistory, LocalAlbumSqlObservationPoint } from './local-album-browser/sql-types.js';
import { LocalAlbumReadError } from './local-album-browser/grouping.js';
import { isLocalAlbumBackgroundCandidateQuery, type LocalAlbumBackgroundCandidateQuery } from './local-album-browser/artwork-background-candidates.js';
import { readLocalAlbumScanState, readLocalAlbumScanStateProjected, readLocalAlbumCueSnapshot, isScanCommittedBatch, isScanFileState } from './local-scan-store.js';
import type { LocalWorkbenchMetadataProvenanceFact } from './local-library-workbench/read-service.js';
import { MobileServiceError } from '../mobile/types.js';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { readSourceRootForDatabase, type SourceStore } from '../recording/source-store.js';
import { CollectionError } from './repository.js';
import type { RootCapability } from '../recording/source-files.js';
import { extractVersionTokens } from '../library/local-name-rules.js';
import { readProjectedLocalMetadata } from '../library/local-artist-fields.js';
import type { ArtistMetadataBackfillCandidate } from './local-artist-metadata-types.js';
import { ORGANIZER_JOURNAL, isOrganizerEvent, organizerHash, organizerCanonical, readOrganizerEvent, verifyOrganizerJournalRow, type OrganizerEvent } from './local-organizer-journal.js';
import { LOCAL_LEGACY_LINKS_OPERATION, LegacyLinksError, legacyLinksFail, emptyLegacyLinksProjection, copyLegacyLinksProjection, readLegacyLinksEvent, projectLegacyLinksEvent, verifyLegacyLinksLocalSnapshot, legacyLinksSlot, type LegacyLinksProjection, type LegacyLinksView, type LegacyLinksWriteView, type LegacyLinksEvent, isLegacyLinksEvent } from './local-legacy-links-journal.js';
import { SOURCE_WRITES_OPERATION, sourceWritesPolicy, sourceWritesFail, emptySourceWritesProjection, copySourceWritesProjection, readSourceWritesEvent, projectSourceWritesEvent, sourceWritesLedgerRow, type SourceWritesProjection, type SourceWritesReadView, type SourceWritesWriteView, type SourceWritesEvent } from './local-source-writes-journal.js';
import { updateSourceWriteScanFacts } from './source-write-scan-port.js';
import { LOCAL_RELOCATION_OPERATION, relocationFail, relocationCanonical, relocationEvent, emptyRelocationProjection, copyRelocationProjection, readRelocationEvent, projectRelocationEvent, relocationLedgerRow, relocationRecoveryFamily, type RelocationProjection, type RelocationReadView, type RelocationWriteView, type RelocationEvent, type RelocationLocationFact, type RelocationStoredPlan } from './local-relocation-journal.js';
import { prepareRelocationScanReads, applyRelocationScanFacts, type RelocationScanReadRequest, type PreparedRelocationReads } from './source-relocation-scan-port.js';
import { relocationReadAccessTargets, type RelocationReadAccess } from './source-relocation-verify.js';

const tables = {
  local_catalog_roots: 'CREATE TABLE local_catalog_roots(id TEXT PRIMARY KEY,source_root_id TEXT NOT NULL REFERENCES source_roots(id),data TEXT NOT NULL) STRICT',
  local_catalog_assets: 'CREATE TABLE local_catalog_assets(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES local_catalog_roots(id),source_root_id TEXT NOT NULL REFERENCES source_roots(id),relative TEXT NOT NULL,sha256 TEXT,data TEXT NOT NULL) STRICT',
  local_catalog_tracks: 'CREATE TABLE local_catalog_tracks(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES local_catalog_assets(id),data TEXT NOT NULL) STRICT',
  local_catalog_editions: 'CREATE TABLE local_catalog_editions(id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT',
  local_catalog_edition_tracks: 'CREATE TABLE local_catalog_edition_tracks(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES local_catalog_editions(id),track_id TEXT NOT NULL REFERENCES local_catalog_tracks(id),data TEXT NOT NULL) STRICT',
  local_catalog_observations: 'CREATE TABLE local_catalog_observations(id TEXT PRIMARY KEY,track_id TEXT NOT NULL REFERENCES local_catalog_tracks(id),data TEXT NOT NULL) STRICT',
  local_catalog_overrides: 'CREATE TABLE local_catalog_overrides(track_id TEXT PRIMARY KEY REFERENCES local_catalog_tracks(id),data TEXT NOT NULL) STRICT',
  local_catalog_ledger: 'CREATE TABLE local_catalog_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,operation TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT',
} as const;
type Table = keyof typeof tables;
/** 300k曲目域与可独立增长的资产、关系、raw观察和命令历史分别设限；不把回执行算成曲目。 */
const rowBudgets: Readonly<Record<Table, number>> = {
  local_catalog_roots: 100,
  local_catalog_assets: 600_000,
  local_catalog_tracks: 300_000,
  local_catalog_editions: 300_000,
  local_catalog_edition_tracks: 1_200_000,
  local_catalog_observations: 2_400_000,
  local_catalog_overrides: 300_000,
  local_catalog_ledger: 12_000_000,
};
const maxRowTextBytes = 64 * 1024, maxCatalogTextBytes = 16 * 1024 * 1024 * 1024;
// 单次集合读预算与全目录容量独立；SQL多取一行判超限，在解析前拒绝。
const maxCatalogReadRows = 200;
export class LocalCatalogBudgetError extends Error {
  constructor(readonly domain: string, readonly actual: number, readonly limit: number) {
    super(`本地目录资源预算超限：${domain}为${actual}，预算${limit}；现有数据保留，需要明确扩容方案。`);
    this.name = 'LocalCatalogBudgetError';
  }
}
interface AuditCertificate { rows: ReadonlyMap<Table, number>; bytes: number; dataVersion: number }
// 仅缓存同连接完整核验产生的资源计数；实体、定位、权限和回执始终读取SQLite原事实。
const audits = new WeakMap<DatabaseSync, AuditCertificate>();
const observationHistoryAudits = new WeakMap<DatabaseSync, { certificate: AuditCertificate; point: LocalAlbumSqlObservationPoint; history: LibraryManagementObservationHistory; handle: LocalAlbumSqlObservationHistory }>();
/** 仅隔离Actor在原Owner队列连续链获准后调用；首次/未知写仍完整核验。 */
export function continueReadonlyQueueCatalogAudit(db: DatabaseSync, previousVersion: number): void {
  const certificate = audits.get(db), saved = observationHistoryAudits.get(db)
  const point = observationHistoryPoint(db)
  if (!certificate || certificate.dataVersion !== previousVersion || !db.isTransaction
    || db.prepare('PRAGMA query_only').get()?.query_only !== 1 || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1
    || saved && (saved.certificate !== certificate || saved.point.version !== previousVersion)) throw new Error('只读队列目录核验作者不匹配。')
  certificate.dataVersion = point.version
  if (saved) { continueReadonlyQueueObservationHistory(db, saved.handle, saved.point, point); saved.point = point }
}
const legacyAudits = new WeakMap<DatabaseSync, LegacyLinksProjection | 'BUDGET_EXCEEDED'>();
const sourceWritesAudits=new WeakMap<DatabaseSync,SourceWritesProjection>();
const relocationAudits = new WeakMap<DatabaseSync, RelocationProjection>();
interface RootRelinkReceipt {commandId:string;ledgerSequence:string;requestFingerprint:string;request:RelinkLibraryRoot;result:dto.LibraryRoot;beforeRoot?:dto.LibraryRoot}
interface WorkbenchAudit {highWater:number; rootRelinks:Map<string,RootRelinkReceipt>;workbench:Map<string,LocalWorkbenchJournalProjection>; lyrics:Map<string,LocalLyricsJournalProjection>;cue:Map<string,LocalCueOwnerProjection>;scanSettings:Map<string,LocalScanSettingsOwnerProjection>;mbOnly:Map<string,LocalWorkbenchMBOnlyProjection>;lyricsPhysical:Map<string,LocalLyricsPhysicalProjection>;management:Map<string,LocalLibraryManagementProjection>;lyricsRoot:Map<string,LocalLyricsRootProjection>}
const workbenchAudits=new WeakMap<DatabaseSync,WorkbenchAudit>();

/** 只供原扫描冷核/参数证据；不签grant、不暴露数据库给服务。 */
export function sourceWritesProjectionForDatabase(db:DatabaseSync):SourceWritesProjection|undefined{return sourceWritesAudits.get(db);}
/** 独立LYRICS来源证明；不会转换成TAGS计划或铸造Source许可。 */
export function lyricsPhysicalPublicationsForDatabase(db:DatabaseSync):readonly {publication:LocalLyricsPhysicalPublication;record:LocalLyricsPhysicalRecord;sequence:number}[]{
  const result:{publication:LocalLyricsPhysicalPublication;record:LocalLyricsPhysicalRecord;sequence:number}[]=[];
  for(const p of workbenchAudits.get(db)?.lyricsPhysical.values()??[])for(const item of p.records.values())
    if(item.publication&&item.publicationSequence!==null)result.push({publication:item.publication,record:item.record,sequence:item.publicationSequence});
  return result.sort((a,b)=>a.sequence-b.sequence);
}
/** 原Scanner只消费已经由目录账本完整冷核的本域事实；此投影不能铸造读取能力。 */
export function relocationProjectionForDatabase(db: DatabaseSync): RelocationProjection | undefined { return relocationAudits.get(db); }
const dataVersion = (db: DatabaseSync): number => Number(db.prepare('PRAGMA data_version').get()?.data_version);
const checkBudget = (domain: string, actual: number, limit: number): void => { if (actual > limit) throw new LocalCatalogBudgetError(domain, actual, limit); };
const indexes = [
  'CREATE UNIQUE INDEX local_catalog_root_binding ON local_catalog_roots(source_root_id)',
  'CREATE INDEX local_catalog_tracks_asset ON local_catalog_tracks(asset_id)',
  'CREATE INDEX local_catalog_observations_track ON local_catalog_observations(track_id)',
  "CREATE UNIQUE INDEX local_catalog_edition_sequence ON local_catalog_edition_tracks(edition_id,json_extract(data,'$.sequence')) WHERE json_extract(data,'$.active')=1",
];
const triggers = Object.keys(tables).map(name => `CREATE TRIGGER ${name}_no_delete BEFORE DELETE ON ${name} BEGIN SELECT RAISE(ABORT,'本地目录身份保留'); END`);
for (const name of ['local_catalog_observations', 'local_catalog_ledger']) triggers.push(`CREATE TRIGGER ${name}_no_update BEFORE UPDATE ON ${name} BEGIN SELECT RAISE(ABORT,'本地目录历史不可改写'); END`);
export const localCatalogMigration = [...Object.values(tables), ...indexes, ...triggers, 'PRAGMA user_version=31'].join(';\n') + ';';

interface Command { commandId: string }
export interface RegisterLibraryRoot extends Command { sourceRootId: string; role: dto.LibraryRootRole }
export interface RelinkLibraryRoot extends RegisterLibraryRoot { rootId: string; expectedRevision: string }
/** 可信作者内部的定位观察；不作为 Renderer/公开点播 DTO。 */
export interface RegisterAudioAsset extends Command {
  libraryRootId: string; expectedRootRevision: string; relative: string; sha256: string | null;
  sampleFrames: string | null; timebaseHz: number | null;
}
export interface MoveAudioAsset extends Command { assetId: string; expectedLocationRevision: string; expectedRootRevision: string; relative: string }
export interface ReplaceAudioAsset extends RegisterAudioAsset { assetId: string; expectedFileRevision: string; expectedLocationRevision: string }
export interface CreateLocalTrack extends Command { assetId: string; segment: Omit<dto.LocalTrackSegment, 'id'> | null }
export interface SelectLocalAsset extends Command { trackId: string; expectedSelectionRevision: string; assetId: string }
export interface CreateAlbumEdition extends Command { title: string; edition: string }
export interface LinkEditionTrack extends Command { editionId: string; trackId: string; disc: number; trackNumber: number; sequence: number }
export interface RemoveEditionTrack extends Command { id: string; expectedRevision: string }
export interface ObserveLocalMetadata extends Command { trackId: string; source: 'tag' | 'synthetic'; parserVersion: string; fields: dto.LocalMetadata }
export interface OverrideLocalMetadata extends Command { trackId: string; expectedRevision: string | null; fields: dto.LocalMetadata; annotations?: dto.LocalMetadataAnnotations }
/** 仅同Owner完整已核capture的选读；这些原pins不由所选片段重新签发。 */
export interface LocalLibraryManagementFrozenAlbumSelection {
  captureRecord: Readonly<Pick<LocalLibraryManagementCaptureRecord, 'schema' | 'kind' | 'datasetId' | 'key' | 'revision' | 'originalSha256'> & {
    original: Pick<LocalLibraryManagementCaptureRecord['original'], 'mode' | 'watermark'>
  }>
  managementCapture: Readonly<LocalLyricsRootRecordMap['original-capture']['managementCapture']>
  album: Readonly<LocalLibraryManagementCapturedAlbum>
}
interface Access { read<T>(operation: (db: DatabaseSync) => T): T; sources: Pick<SourceStore, 'root'>; conflict(message: string): never; beforeCommit?: (action: string) => void; beforeLocalFactsCommit?: () => void; onLocalFactsFatal?: () => void }
type Row = Record<string, unknown>;
const rowBytes = (row: Row): number => Object.values(row).reduce<number>((bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value) : 0), 0);
const boundedRow = (row: Row): void => { if (rowBytes(row) > maxRowTextBytes) corrupt(); };
const corrupt = (): never => { throw new Error('本地目录结构或历史损坏，保留现有数据。'); };
const record = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Row, names: readonly string[]): boolean => names.every(name => Object.hasOwn(v, name)) && Object.keys(v).every(name => names.includes(name));
const relativePath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
  && !/[\u0000-\u001f\u007f\\:]/u.test(v) && !path.posix.isAbsolute(v) && v.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const sha = (v: unknown): boolean => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const ordinal = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 1_000_000;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (record(v)) return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${canonical(v[key])}`).join(',')}}`;
  return JSON.stringify(v);
}
const fingerprint = (operation: dto.LocalCatalogOperation, request: unknown): string => createHash('sha256').update(canonical([operation, request])).digest('hex');
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
/** 根恢复只沿原READY整库端点对正向或反向；父链存在不能代替当前完整CAS。 */
function relocationRootReassociationMatches(projection: RelocationProjection, stored: RelocationStoredPlan, before: dto.LibraryRoot, after: dto.LibraryRoot): boolean {
  if (!stored.ready || stored.plan.planHash !== stored.ready.planHash) return false;
  const mappingMatches = (mapping: dto.LocalRelocationRootMapping): boolean => mapping.source.libraryRootId === before.id
    && mapping.source.sourceRootId === before.sourceRootId && mapping.source.expectedRootRevision === before.revision
    && mapping.target.libraryRootId === after.id && mapping.target.sourceRootId === after.sourceRootId && mapping.target.expectedRootRevision === after.revision;
  if (!stored.recoveryOrigin) return stored.plan.intent.kind === 'root-reassociate' && stored.plan.intent.libraryRootId === before.id
    && stored.plan.intent.expectedRootRevision === before.revision && stored.rootMappings.some(mappingMatches);
  if (stored.plan.intent.kind !== 'recovery' || stored.recoveryOrigin.action === 'reconcile') return false;
  const family = relocationRecoveryFamily(projection, stored.plan.planId), original = family[0];
  if (!original?.ready || original.plan.intent.kind !== 'root-reassociate' || original.plan.intent.libraryRootId !== before.id
    || stored.recoveryOrigin.familyRootPlanId !== original.plan.planId || original.rootMappings.length < 1 || stored.rootMappings.length < 1) return false;
  const endpoints = original.rootMappings[0]!;
  if (original.rootMappings.some(mapping => mapping.source.libraryRootId !== before.id || mapping.target.libraryRootId !== before.id
    || mapping.source.sourceRootId !== endpoints.source.sourceRootId || mapping.target.sourceRootId !== endpoints.target.sourceRootId)
    || endpoints.source.sourceRootId === endpoints.target.sourceRootId) return false;
  const forward = stored.recoveryOrigin.action === 'keep-target';
  if (before.sourceRootId !== (forward ? endpoints.source.sourceRootId : endpoints.target.sourceRootId)
    || after.sourceRootId !== (forward ? endpoints.target.sourceRootId : endpoints.source.sourceRootId)
    || stored.rootMappings.some(mapping => !mappingMatches(mapping))) return false;
  const audio = stored.resources.filter(resource => resource.frozen.role === 'AUDIO');
  return audio.length > 0 && audio.length === stored.operations.length && stored.operations.every(operation => operation.source !== null
    && same(operation.source.libraryRoot, before) && operation.operation.source.libraryRootId === before.id
    && operation.operation.source.sourceRootId === before.sourceRootId && operation.operation.source.expectedRootRevision === before.revision
    && operation.operation.target.libraryRootId === after.id && operation.operation.target.sourceRootId === after.sourceRootId
    && operation.operation.target.expectedRootRevision === after.revision)
    && audio.every(resource => resource.frozen.source.libraryRootId === before.id && resource.frozen.source.sourceRootId === before.sourceRootId
      && resource.frozen.source.expectedRootRevision === before.revision && resource.frozen.target.libraryRootId === after.id
      && resource.frozen.target.sourceRootId === after.sourceRootId && resource.frozen.target.expectedRootRevision === after.revision);
}
const next = (revision: string): string => { const value = (BigInt(revision) + 1n).toString(); return dto.isLocalCatalogRevision(value) ? value : corrupt(); };
function frames(v: Row): boolean {
  return (v.sampleFrames === null && v.timebaseHz === null) || dto.isLocalExactInteger(v.sampleFrames) && v.sampleFrames !== '0'
    && typeof v.timebaseHz === 'number' && Number.isSafeInteger(v.timebaseHz) && v.timebaseHz > 0 && v.timebaseHz <= 1_000_000_000;
}
function segment(v: unknown): boolean {
  return v === null || record(v) && keys(v, ['startFrame', 'endFrameExclusive', 'timebaseHz'])
    && dto.isLocalTrackSegment({ id: '11111111-1111-4111-8111-111111111111', ...v });
}
function validRequest(operation: dto.LocalCatalogOperation, v: unknown): v is Row & { commandId: string } {
  if (!record(v) || !dto.isCollectionId(v.commandId)) return false;
  const asset = ['commandId', 'libraryRootId', 'expectedRootRevision', 'relative', 'sha256', 'sampleFrames', 'timebaseHz'];
  const assetValues = (): boolean => dto.isCollectionId(v.libraryRootId) && dto.isLocalCatalogRevision(v.expectedRootRevision) && relativePath(v.relative) && sha(v.sha256) && frames(v);
  switch (operation) {
    case 'register-root': return keys(v, ['commandId', 'sourceRootId', 'role']) && dto.isCollectionId(v.sourceRootId) && dto.isLibraryRootRole(v.role);
    case 'relink-root': return keys(v, ['commandId', 'sourceRootId', 'role', 'rootId', 'expectedRevision']) && dto.isCollectionId(v.sourceRootId) && dto.isLibraryRootRole(v.role) && dto.isCollectionId(v.rootId) && dto.isLocalCatalogRevision(v.expectedRevision);
    case 'register-asset': return keys(v, asset) && assetValues();
    case 'replace-asset': return keys(v, [...asset, 'assetId', 'expectedFileRevision', 'expectedLocationRevision']) && assetValues() && dto.isCollectionId(v.assetId) && dto.isLocalCatalogRevision(v.expectedFileRevision) && dto.isLocalCatalogRevision(v.expectedLocationRevision);
    case 'move-asset': return keys(v, ['commandId', 'assetId', 'expectedLocationRevision', 'expectedRootRevision', 'relative']) && dto.isCollectionId(v.assetId) && dto.isLocalCatalogRevision(v.expectedLocationRevision) && dto.isLocalCatalogRevision(v.expectedRootRevision) && relativePath(v.relative);
    case 'create-track': return keys(v, ['commandId', 'assetId', 'segment']) && dto.isCollectionId(v.assetId) && segment(v.segment);
    case 'select-asset': return keys(v, ['commandId', 'trackId', 'expectedSelectionRevision', 'assetId']) && dto.isCollectionId(v.trackId) && dto.isLocalCatalogRevision(v.expectedSelectionRevision) && dto.isCollectionId(v.assetId);
    case 'create-edition': return keys(v, ['commandId', 'title', 'edition']) && dto.isLocalCatalogText(v.title) && dto.isLocalCatalogText(v.edition, true);
    case 'link-edition-track': return keys(v, ['commandId', 'editionId', 'trackId', 'disc', 'trackNumber', 'sequence']) && dto.isCollectionId(v.editionId) && dto.isCollectionId(v.trackId) && ordinal(v.disc) && ordinal(v.trackNumber) && ordinal(v.sequence);
    case 'remove-edition-track': return keys(v, ['commandId', 'id', 'expectedRevision']) && dto.isCollectionId(v.id) && dto.isLocalCatalogRevision(v.expectedRevision);
    case 'observe-metadata': return keys(v, ['commandId', 'trackId', 'source', 'parserVersion', 'fields']) && dto.isCollectionId(v.trackId) && (v.source === 'tag' || v.source === 'synthetic') && dto.isLocalCatalogText(v.parserVersion) && dto.isLocalMetadata(v.fields) && Object.keys(v.fields).length > 0;
    case 'override-metadata': return keys(v, ['commandId', 'trackId', 'expectedRevision', 'fields', ...(Object.hasOwn(v, 'annotations') ? ['annotations'] : [])]) && dto.isCollectionId(v.trackId) && (v.expectedRevision === null || dto.isLocalCatalogRevision(v.expectedRevision)) && dto.isLocalMetadata(v.fields) && (!Object.hasOwn(v, 'annotations') || dto.isLocalMetadataAnnotations(v.annotations));
  }
}
function parse<T>(value: unknown, guard: (v: unknown) => v is T): T {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536) return corrupt();
  const result: unknown = JSON.parse(value); return guard(result) ? result : corrupt();
}
const readRoot = (row: Row): dto.LibraryRoot => { const result = parse(row.data, dto.isLibraryRoot); if (row.id !== result.id || row.source_root_id !== result.sourceRootId) return corrupt(); return result; };
const readAsset = (row: Row): dto.AudioAsset => { const result = parse(row.data, dto.isAudioAsset); if (row.id !== result.id || row.root_id !== result.libraryRootId || row.source_root_id !== result.sourceRootId || !relativePath(row.relative) || !sha(row.sha256)) return corrupt(); return result; };
const readTrack = (row: Row): dto.LocalTrack => { const result = parse(row.data, dto.isLocalTrack); if (row.id !== result.id || row.asset_id !== result.assetId) return corrupt(); return result; };
function libraryMetadata(db: DatabaseSync, trackId: string): dto.LocalMetadataView {
  const anchor=sourceWritesAudits.get(db)?.fullRaw.get(trackId);
  const rows = db.prepare(`SELECT o.data FROM local_catalog_observations o WHERE o.track_id=? ${anchor?"AND EXISTS(SELECT 1 FROM local_catalog_ledger l WHERE l.rowid>? AND l.operation='observe-metadata' AND json_extract(l.result,'$.id')=o.id)":''} ORDER BY o.rowid LIMIT 201`).all(...(anchor?[trackId,anchor.ledgerOrdinal]:[trackId]));
  if (rows.length > maxCatalogReadRows) throw new LocalCatalogBudgetError('详情原始标签读取行数', rows.length, maxCatalogReadRows);
  const raw: dto.LocalMetadata = {...anchor?.fields};
  for (const row of rows) Object.assign(raw, parse(row.data, dto.isLocalMetadataObservation).fields);
  const row = db.prepare('SELECT data FROM local_catalog_overrides WHERE track_id=?').get(trackId);
  const override = row ? parse(row.data, dto.isLocalMetadataOverride) : null;
  return { raw, override, effective: dto.mergeLocalMetadata(raw, override?.fields) };
}
function libraryVersionTokens(fields: dto.LocalMetadata): dto.VersionNameToken[] {
  return (['title', 'artist', 'album'] as const).flatMap(source => fields[source] ? extractVersionTokens(fields[source]!, source) : []).slice(0, 64);
}
const libraryFields = [...dto.LOCAL_METADATA_TEXT_FIELDS, ...dto.LOCAL_METADATA_ARTIST_FIELDS];
// 每个字段按原观察历史的最后一次存在值读取；部分标签观察不会抹掉未提供字段。
const libraryObservationCurrent = `CASE
  WHEN sf.ordinal IS NULL THEN 1
  WHEN EXISTS(SELECT 1 FROM (SELECT l.operation,l.result FROM local_catalog_ledger l WHERE l.rowid>sf.ordinal ORDER BY l.rowid LIMIT 1) first_observation
    WHERE first_observation.operation='observe-metadata' AND json_extract(first_observation.result,'$.id')=o.id) THEN 1
  ELSE EXISTS(SELECT 1 FROM library_current_observations current_observation WHERE current_observation.id=o.id AND current_observation.source_ordinal=sf.ordinal) END`;
const libraryRaw = (field: string, indexed = false, anchored = true) => `COALESCE((SELECT json_extract(o.data,'$.fields.${field}') FROM local_catalog_observations o WHERE o.track_id=t.id AND json_type(o.data,'$.fields.${field}') IS NOT NULL AND ${!anchored ? '1' : indexed ? `COALESCE(mb_album_observation_after(t.id,CAST(o.rowid AS TEXT),sf.ordinal),${libraryObservationCurrent})` : libraryObservationCurrent} ORDER BY o.rowid DESC LIMIT 1),json_extract(sf.fields,'$.${field}'))`;
// 只保本次SELECT的观察ID/序号；原六字段仍分别按观察行号取最后存在值。
// 放在candidates内部，原移动目录source_marks改写后仍只消费本次选中的Source行。
// 后缀账本扫描一次且只物化候选ID；不缓存权限、Source判断或跨请求的历史映射。
// 后继首行已正向证明时不构造集合；未命中仍核完整后缀，不能把首行不匹配当作不存在。
const libraryProjectionSql = (indexed = false, anchored = true) => `WITH source_full AS (SELECT CAST(json_extract(value,'$.trackId') AS TEXT) track_id,CAST(json_extract(value,'$.ordinal') AS INTEGER) ordinal,json_extract(value,'$.fields') fields FROM json_each(@sourceRaw)),candidates AS (
  WITH library_anchor_observations AS MATERIALIZED(SELECT o.id,sf.ordinal source_ordinal FROM source_full sf
    CROSS JOIN local_catalog_observations o ON o.track_id=sf.track_id WHERE sf.ordinal IS NOT NULL),
  library_observation_events AS MATERIALIZED(SELECT l.rowid ordinal,json_extract(l.result,'$.id') id FROM local_catalog_ledger l
    WHERE l.rowid>(SELECT min(source_ordinal) FROM library_anchor_observations) AND l.operation='observe-metadata'
      AND json_extract(l.result,'$.id') IN(SELECT id FROM library_anchor_observations)),
  library_current_observations AS MATERIALIZED(SELECT DISTINCT o.id,o.source_ordinal FROM library_observation_events e
    JOIN library_anchor_observations o ON e.id=o.id AND e.ordinal>o.source_ordinal)
  SELECT t.rowid ordinal,t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,
  ${libraryFields.flatMap(field => {
    const scalar = field === 'artists' ? 'artist' : field === 'albumArtists' ? 'albumArtist' : null;
    const effective = `COALESCE(json_extract(v.data,'$.fields.${field}'),${libraryRaw(field,indexed,anchored)})`;
    return [`${libraryRaw(field,indexed,anchored)} raw_${field}`, `${scalar ? `CASE WHEN json_type(v.data,'$.fields.${scalar}') IS NOT NULL AND json_type(v.data,'$.fields.${field}') IS NULL THEN NULL ELSE ${effective} END` : effective} effective_${field}`];
  }).join(',')}
  FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE (@root IS NULL OR a.root_id=@root))`;
export const localCatalogLibraryProjectionSql = libraryProjectionSql();
const libraryProjection = localCatalogLibraryProjectionSql, indexedLibraryProjection = libraryProjectionSql(true);
// 原Source审计明确没有任何标签锚时，全部观察均有效；只在私有Reader选择，不绕过Source/数据库守卫。
const unanchoredLibraryProjection = libraryProjectionSql(false, false);
function observationHistoryPoint(db:DatabaseSync):LocalAlbumSqlObservationPoint {
  const row=db.prepare('SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS version,(SELECT schema_version FROM pragma_schema_version) AS schema').get();
  if(![row?.changes,row?.version,row?.schema].every(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)||typeof db.isTransaction!=='boolean')return corrupt();
  return {changes:Number(row!.changes),version:Number(row!.version),schema:Number(row!.schema),transaction:db.isTransaction};
}
function publishObservationHistory(db:DatabaseSync,certificate:AuditCertificate,point:LocalAlbumSqlObservationPoint,history:LibraryManagementObservationHistory):void {
  const handle:LocalAlbumSqlObservationHistory=createLocalAlbumSqlObservationHistory(db,point,(trackId,rowId)=>{
    const values=history.byTrack?.get(trackId);if(!values)return undefined;
    for(let i=0;i<values.length;i+=2)if(values[i]===rowId){const ordinal=values[i+1];return typeof ordinal==='number'?ordinal:undefined;}
    return undefined;
  },()=>audits.get(db)===certificate&&observationHistoryAudits.get(db)?.handle===handle);
  observationHistoryAudits.set(db,{certificate,point,history,handle});
}
/** 仅冷启动无测试钩子的原COMMIT；成功后精确衔接只读冷核，恢复写一律回退。 */
export function commitLocalCatalogStartupAudit(db:DatabaseSync):void {
  let candidate:ReturnType<typeof observationHistoryAudits.get>;
  try {
    const saved=observationHistoryAudits.get(db);
    if(saved&&saved.point.transaction&&audits.get(db)===saved.certificate&&same(saved.point,observationHistoryPoint(db)))candidate=saved;
    else observationHistoryAudits.delete(db);
  }catch{observationHistoryAudits.delete(db);}
  // 原提交必须恰好执行一次；异常不能被纯缓存旁注吞掉。
  try{db.exec('COMMIT');}catch(error){observationHistoryAudits.delete(db);throw error;}
  try {
    const point=observationHistoryPoint(db);
    if(!candidate||audits.get(db)!==candidate.certificate||observationHistoryAudits.get(db)!==candidate
      ||point.transaction||!same(point,{...candidate.point,transaction:false})){observationHistoryAudits.delete(db);return;}
    publishObservationHistory(db,candidate.certificate,point,candidate.history);
  }catch{observationHistoryAudits.delete(db);}
}
/** 同DB、完整冷核作者及实际SQLite水位相等才提供纯观察关系；无权限/FD/原观察正文。 */
export function localCatalogLibraryObservationSourceForDatabase(db:DatabaseSync):{projectionSql:string;observationHistory:LocalAlbumSqlObservationHistory}|undefined {
  const saved=observationHistoryAudits.get(db);if(!saved)return undefined;
  if(audits.get(db)!==saved.certificate||!same(saved.point,observationHistoryPoint(db))){observationHistoryAudits.delete(db);return undefined;}
  return {projectionSql:indexedLibraryProjection,observationHistory:saved.handle};
}
const libraryWhere = `(@query='' OR ${['title', 'artist', 'album', 'year'].flatMap(field => [`instr(lower(COALESCE(raw_${field},'')),lower(@query))>0`, `instr(lower(COALESCE(effective_${field},'')),lower(@query))>0`]).join(' OR ')}
  OR EXISTS(SELECT 1 FROM local_catalog_edition_tracks l JOIN local_catalog_editions e ON e.id=l.edition_id WHERE l.track_id=candidates.id AND json_extract(l.data,'$.active')=1 AND (instr(lower(json_extract(e.data,'$.title')),lower(@query))>0 OR instr(lower(json_extract(e.data,'$.edition')),lower(@query))>0)))`;
function checkSegment(track: dto.LocalTrack, asset: dto.AudioAsset): void {
  if (track.segment && (asset.sampleFrames === null || track.segment.timebaseHz !== asset.timebaseHz || BigInt(track.segment.endFrameExclusive) > BigInt(asset.sampleFrames))) return corrupt();
}
const resultTable = (operation: dto.LocalCatalogOperation): Table => {
  switch (operation) {
    case 'register-root': case 'relink-root': return 'local_catalog_roots';
    case 'register-asset': case 'move-asset': case 'replace-asset': return 'local_catalog_assets';
    case 'create-track': case 'select-asset': return 'local_catalog_tracks';
    case 'create-edition': return 'local_catalog_editions';
    case 'link-edition-track': case 'remove-edition-track': return 'local_catalog_edition_tracks';
    case 'observe-metadata': return 'local_catalog_observations';
    case 'override-metadata': return 'local_catalog_overrides';
  }
};

interface HistoryRelations { tracks: Map<string, Map<string, dto.LocalTrack>>; editionSequences: Map<string, Set<number>> }
/** 逐回执重放身份与修订关系，防止只改实体和末条JSON便伪造一条有效历史。 */
function verifyHistoryStep(db: DatabaseSync, operation: dto.LocalCatalogOperation, request: Row, result: dto.LocalCatalogResult,
  latest: Map<string, dto.LocalCatalogResult>, privateAssets: Map<string, { relative: unknown; sha256: unknown }>, observations: Map<string, string>, relations?: HistoryRelations,
  assertReadActive?: () => void): void {
  const history = <T extends dto.LocalCatalogResult>(table: Table, id: unknown, guard: (v: unknown) => v is T): T => {
    const value = latest.get(`${table}:${String(id)}`); return guard(value) ? value : corrupt();
  };
  const root = (id: unknown, revision: unknown) => {
    const value = history('local_catalog_roots', id, dto.isLibraryRoot); if (value.revision !== revision) return corrupt(); return value;
  };
  const asset = (id: unknown) => history('local_catalog_assets', id, dto.isAudioAsset);
  const track = (id: unknown) => history('local_catalog_tracks', id, dto.isLocalTrack);
  const equal = (expected: unknown): void => { if (!same(result, expected)) corrupt(); };
  const source = (id: unknown): void => { if (!db.prepare('SELECT 1 FROM source_roots WHERE id=?').get(String(id))) corrupt(); };
  switch (operation) {
    case 'register-root': {
      const value = result as dto.LibraryRoot; source(request.sourceRootId);
      equal({ id: value.id, sourceRootId: request.sourceRootId, role: request.role, revision: '1' }); break;
    }
    case 'relink-root': {
      const old = root(request.rootId, request.expectedRevision); source(request.sourceRootId);
      equal({ ...old, sourceRootId: request.sourceRootId, role: request.role, revision: next(old.revision) }); break;
    }
    case 'register-asset': {
      const selected = root(request.libraryRootId, request.expectedRootRevision), value = result as dto.AudioAsset;
      equal({ id: value.id, libraryRootId: selected.id, sourceRootId: selected.sourceRootId, rootRevision: selected.revision, fileRevision: '1', locationRevision: '1', sampleFrames: request.sampleFrames, timebaseHz: request.timebaseHz }); break;
    }
    case 'move-asset': {
      const old = asset(request.assetId), selected = root(old.libraryRootId, request.expectedRootRevision);
      if (old.locationRevision !== request.expectedLocationRevision || old.sourceRootId !== selected.sourceRootId) return corrupt();
      equal({ ...old, rootRevision: selected.revision, locationRevision: next(old.locationRevision) }); break;
    }
    case 'replace-asset': {
      const old = asset(request.assetId), selected = root(request.libraryRootId, request.expectedRootRevision), location = privateAssets.get(old.id);
      if (!location || old.fileRevision !== request.expectedFileRevision || old.locationRevision !== request.expectedLocationRevision || old.libraryRootId !== selected.id) return corrupt();
      const moved = location.relative !== request.relative || old.sourceRootId !== selected.sourceRootId;
      equal({ ...old, sourceRootId: selected.sourceRootId, rootRevision: selected.revision, fileRevision: next(old.fileRevision), locationRevision: moved ? next(old.locationRevision) : old.locationRevision, sampleFrames: request.sampleFrames, timebaseHz: request.timebaseHz });
      if (relations) {
        for (const selected of relations.tracks.get(old.id)?.values() ?? []) { assertReadActive?.(); checkSegment(selected, result as dto.AudioAsset); }
      } else for (const [key, value] of latest) if (key.startsWith('local_catalog_tracks:') && dto.isLocalTrack(value) && value.assetId === old.id) checkSegment(value, result as dto.AudioAsset);
      break;
    }
    case 'create-track': {
      const selected = asset(request.assetId), value = result as dto.LocalTrack;
      equal({ id: value.id, assetId: selected.id, selectionRevision: '1', segment: request.segment === null ? null : { ...(request.segment as Row), id: value.segment?.id } });
      checkSegment(value, selected); break;
    }
    case 'select-asset': {
      const old = track(request.trackId), selected = asset(request.assetId);
      if (old.selectionRevision !== request.expectedSelectionRevision) return corrupt();
      equal({ ...old, assetId: selected.id, selectionRevision: next(old.selectionRevision) }); checkSegment(result as dto.LocalTrack, selected); break;
    }
    case 'create-edition': {
      equal({ id: (result as dto.AlbumEdition).id, title: request.title, edition: request.edition, revision: '1' }); break;
    }
    case 'link-edition-track': {
      history('local_catalog_editions', request.editionId, dto.isAlbumEdition); track(request.trackId);
      if (relations) {
        if (relations.editionSequences.get(String(request.editionId))?.has(Number(request.sequence))) return corrupt();
      } else for (const [key, value] of latest) if (key.startsWith('local_catalog_edition_tracks:') && dto.isAlbumEditionTrack(value) && value.active && value.editionId === request.editionId && value.sequence === request.sequence) return corrupt();
      equal({ id: (result as dto.AlbumEditionTrack).id, editionId: request.editionId, trackId: request.trackId, disc: request.disc, trackNumber: request.trackNumber, sequence: request.sequence, revision: '1', active: true }); break;
    }
    case 'remove-edition-track': {
      const old = history('local_catalog_edition_tracks', request.id, dto.isAlbumEditionTrack);
      if (!old.active || old.revision !== request.expectedRevision) return corrupt(); equal({ ...old, revision: next(old.revision), active: false }); break;
    }
    case 'observe-metadata': {
      const selected = track(request.trackId), previous = observations.get(selected.id), revision = previous ? next(previous) : '1';
      equal({ id: (result as dto.LocalMetadataObservation).id, trackId: selected.id, revision, source: request.source, parserVersion: request.parserVersion, fields: request.fields });
      observations.set(selected.id, revision); break;
    }
    case 'override-metadata': {
      const selected = track(request.trackId), old = latest.get(`local_catalog_overrides:${selected.id}`);
      if (old !== undefined && !dto.isLocalMetadataOverride(old)) return corrupt();
      const previous = old as dto.LocalMetadataOverride | undefined;
      if ((previous?.revision ?? null) !== request.expectedRevision) return corrupt();
      const annotations = Object.hasOwn(request, 'annotations') ? request.annotations : previous?.annotations;
      equal({ trackId: selected.id, revision: previous ? next(previous.revision) : '1', fields: request.fields, ...(annotations === undefined ? {} : { annotations }) }); break;
    }
  }
}

/** 同连接/只读备份均核真实DDL、关系、私有位置和全部回执；不打开第二写连接。 */
export function verifyLocalCatalogDatabase(db: DatabaseSync, assertReadActive?: () => void): void {
  // 只保留本次完整核验的最多32条语句；每次仍实读SQLite，不缓存行或跨调用续用。
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    assertReadActive?.();
    const saved = statements.get(sql);
    if (saved) return saved;
    const statement = db.prepare(sql);
    if (statements.size >= 32) statements.delete(statements.keys().next().value!);
    statements.set(sql, statement);
    return statement;
  };
  audits.delete(db);
  observationHistoryAudits.delete(db);
  legacyAudits.delete(db);
  sourceWritesAudits.delete(db);
  relocationAudits.delete(db);
  workbenchAudits.delete(db);
  // 取消只中断本次核验，异常沿调用方原回滚链传播；不能发表部分审计证书。
  assertReadActive?.();
  const initialDataVersion = dataVersion(db);
  const initialObservationPoint = observationHistoryPoint(db);
  for (const [name, sql] of Object.entries(tables)) if (prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for (const [type, statements] of [['index', indexes], ['trigger', triggers]] as const) for (const sql of statements) {
    const name = sql.split(' ')[type === 'index' && sql.startsWith('CREATE UNIQUE') ? 3 : 2]!;
    if (prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, name)?.sql !== sql) return corrupt();
  }
  let bytes = 0;
  const counts = new Map<Table, number>();
  for (const table of Object.keys(tables) as Table[]) {
    const textColumns = prepare(`PRAGMA table_info(${table})`).all().filter(c => c.type === 'TEXT').map(c => String(c.name));
    const rowTextSize = textColumns.map(c => `COALESCE(length(CAST(${c} AS BLOB)),0)`).join('+');
    const size = prepare(`SELECT count(*) n,COALESCE(sum(${rowTextSize}),0) bytes,COALESCE(max(${rowTextSize}),0) largest FROM ${table}`).get()!;
    if (Number(size.largest) > maxRowTextBytes) return corrupt();
    const count = Number(size.n); checkBudget(`${table}行数`, count, rowBudgets[table]); counts.set(table, count); bytes += Number(size.bytes);
  }
  checkBudget('目录总文本字节', bytes, maxCatalogTextBytes);
  const latest = new Map<string, dto.LocalCatalogResult>();
  const privateAssets = new Map<string, { relative: unknown; sha256: unknown }>();
  const observations = new Map<string, string>();
  // 同一32MiB预算内预留句柄/水位/闭包等固定开销，不在原Map预算外另建观察索引。
  const managementObservations: LibraryManagementObservationHistory = { byTrack: new Map(), allocationBytes: 4096 };
  const relations: HistoryRelations = { tracks: new Map(), editionSequences: new Map() };
  let immutableObservations = 0;
  let legacy: LegacyLinksProjection | 'BUDGET_EXCEEDED' = emptyLegacyLinksProjection();
  const sourceWrites=emptySourceWritesProjection();
  const workbench:WorkbenchAudit={highWater:0,rootRelinks:new Map(),workbench:new Map(),lyrics:new Map(),cue:new Map(),scanSettings:new Map(),mbOnly:new Map(),lyricsPhysical:new Map(),management:new Map(),lyricsRoot:new Map()};
  const relocation = emptyRelocationProjection();
  const rootFactsObligations = new Map<string, { before: dto.LibraryRoot; after: dto.LibraryRoot;
    pending: Map<string, { operationId: string; resourceId: string }> }>();
  for (const row of prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger ORDER BY rowid').iterate()) {
    assertReadActive?.();
    boundedRow(row);
    const ledgerRowId=Number(row._ledger_rowid);if(!Number.isSafeInteger(ledgerRowId)||ledgerRowId<1)return corrupt();
    if(typeof legacy!=='string')legacy.highWater=ledgerRowId;
    if (row.operation === LOCAL_RELOCATION_OPERATION) {
      const event = readRelocationEvent(row);
      if (event.kind === 'root-facts') {
        const prior = latest.get(`local_catalog_roots:${event.beforeRoot.id}`);
        if (!same(prior, event.beforeRoot) || !same(event.afterRoot, { ...event.beforeRoot, sourceRootId: event.afterRoot.sourceRootId, revision: next(event.beforeRoot.revision) })) return corrupt();
        const stored = relocation.plans.get(event.planId!);
        if (!stored || !relocationRootReassociationMatches(relocation, stored, event.beforeRoot, event.afterRoot)) return corrupt();
        // 只按此历史点重放出的成员核闭集；最终SQL成员不能代替迁移当时的集合。
        const members = new Set<string>();
        for (const value of latest.values()) {
          assertReadActive?.();
          if (dto.isAudioAsset(value) && value.libraryRootId === event.beforeRoot.id) {
            members.add(value.id); if (members.size > dto.LOCAL_RELOCATION_PLAN_BUDGET.operations) return corrupt();
          }
        }
        const audio = stored.resources.filter(resource => resource.frozen.role === 'AUDIO');
        const operationAssets = stored.operations.map(operation => operation.source?.asset.id);
        const audioAssets = audio.map(resource => resource.frozen.operationIds.length === 1
          ? stored.operations.find(operation => operation.operation.operationId === resource.frozen.operationIds[0])?.source?.asset.id : undefined);
        if (!members.size || members.size !== operationAssets.length || members.size !== audioAssets.length
          || new Set(operationAssets).size !== members.size || new Set(audioAssets).size !== members.size
          || operationAssets.some(id => id === undefined || !members.has(id)) || audioAssets.some(id => id === undefined || !members.has(id))) return corrupt();
        if (rootFactsObligations.has(event.planId!)) return corrupt();
        rootFactsObligations.set(event.planId!, { before: event.beforeRoot, after: event.afterRoot,
          pending: new Map(audio.map(resource => {
            const operationId = resource.frozen.operationIds[0]!;
            const assetId = stored.operations.find(operation => operation.operation.operationId === operationId)!.source!.asset.id;
            return [assetId, { operationId, resourceId: resource.frozen.resourceId }];
          })) });
        latest.set(`local_catalog_roots:${event.afterRoot.id}`, event.afterRoot);
      } else if (event.kind === 'location-facts') {
        const fact = event.fact, before = latest.get(`local_catalog_assets:${fact.beforeAsset.id}`), beforeLocation = privateAssets.get(fact.beforeAsset.id);
        const selected = latest.get(`local_catalog_roots:${fact.target.libraryRootId}`), original = latest.get(`local_catalog_roots:${fact.source.libraryRootId}`);
        const stored = relocation.plans.get(event.planId!), sourceRoot = stored?.operations.find(operation => operation.operation.operationId === fact.operationId)?.source?.libraryRoot;
        const rootMoved = stored?.events.some(prior => prior.kind === 'root-facts' && same(prior.beforeRoot, sourceRoot) && same(prior.afterRoot, original));
        if (!same(before, fact.beforeAsset) || !same(beforeLocation, { relative: fact.source.relative, sha256: fact.catalogSha256 })
          || !dto.isLibraryRoot(selected) || selected.sourceRootId !== fact.target.sourceRootId || selected.revision !== fact.target.rootRevision
          || !dto.isLibraryRoot(original) || !sourceRoot || !same(original, sourceRoot) && !rootMoved
          || sourceRoot.id !== fact.source.libraryRootId || sourceRoot.sourceRootId !== fact.source.sourceRootId || sourceRoot.revision !== fact.source.rootRevision) return corrupt();
        const rootObligation = rootFactsObligations.get(event.planId!);
        if (rootObligation) {
          const expected = rootObligation.pending.get(fact.beforeAsset.id), { before: oldRoot, after: newRoot } = rootObligation;
          if (!expected || expected.operationId !== fact.operationId || expected.resourceId !== fact.resourceId
            || fact.source.libraryRootId !== oldRoot.id || fact.source.sourceRootId !== oldRoot.sourceRootId || fact.source.rootRevision !== oldRoot.revision
            || fact.target.libraryRootId !== newRoot.id || fact.target.sourceRootId !== newRoot.sourceRootId || fact.target.rootRevision !== newRoot.revision
            || fact.beforeAsset.libraryRootId !== oldRoot.id || fact.beforeAsset.sourceRootId !== oldRoot.sourceRootId || fact.beforeAsset.rootRevision !== oldRoot.revision
            || fact.afterAsset.libraryRootId !== newRoot.id || fact.afterAsset.sourceRootId !== newRoot.sourceRootId || fact.afterAsset.rootRevision !== newRoot.revision) return corrupt();
        }
        const members = relations.tracks.get(fact.beforeAsset.id);
        if (!members || members.size !== fact.tracks.length || fact.tracks.some(track => !same(members.get(track.id), track))) return corrupt();
        for (const track of fact.tracks) { assertReadActive?.(); checkSegment(track, fact.afterAsset); }
        latest.set(`local_catalog_assets:${fact.afterAsset.id}`, fact.afterAsset);
        privateAssets.set(fact.afterAsset.id, { relative: fact.target.relative, sha256: fact.catalogSha256 });
        rootObligation?.pending.delete(fact.beforeAsset.id);
      }
      projectRelocationEvent(relocation, event, ledgerRowId); continue;
    }
    if(row.operation===SOURCE_WRITES_OPERATION){
      const event=readSourceWritesEvent(row);
      if(event.kind==='facts'){
        const fact=event.fact,child=prepare("SELECT result,request FROM local_catalog_ledger WHERE command_id=? AND operation='replace-asset'").get(fact.replaceCommandId);
        if(!child||!same(JSON.parse(String(child.result)),fact.afterAsset)||!same(latest.get(`local_catalog_assets:${fact.afterAsset.id}`),fact.afterAsset))return corrupt();
        const request=JSON.parse(String(child.request)) as Row;if(request.sha256!==fact.observation.sha256||request.expectedFileRevision!==fact.beforeAsset.fileRevision)return corrupt();
        for(const id of fact.affectedTrackIds){assertReadActive?.();const t=latest.get(`local_catalog_tracks:${id}`);if(!dto.isLocalTrack(t)||t.assetId!==fact.afterAsset.id||t.segment!==null)return corrupt();}
      }
      projectSourceWritesEvent(sourceWrites,event,ledgerRowId);continue;
    }
    if(row.operation===LOCAL_LEGACY_LINKS_OPERATION){
      if(typeof legacy!=='string'){
        try{const event=readLegacyLinksEvent(row);verifyLegacyLinksLocalSnapshot(event,latest,privateAssets);projectLegacyLinksEvent(legacy,event);}
        catch(error){if(error instanceof LegacyLinksError&&error.code==='BUDGET_EXCEEDED')legacy='BUDGET_EXCEEDED';else throw error;}
      }
      continue;
    }
    if(row.operation===LOCAL_LYRICS_ROOT_OPERATION){
      const event=readLocalLyricsRootEvent(row),p=workbench.lyricsRoot.get(event.datasetId)??emptyLocalLyricsRootProjection(event.datasetId);
      const value=projectLocalLyricsRootEvent(p,event,ledgerRowId);workbench.lyricsRoot.set(event.datasetId,p);if(value)verifyLyricsRootRecord(db,workbench,value,false,latest);continue;
    }
    if(row.operation===LOCAL_LIBRARY_MANAGEMENT_OPERATION){
      const event=readLocalLibraryManagementEvent(row),p=workbench.management.get(event.datasetId)??emptyLocalLibraryManagementProjection(event.datasetId);
      const stored=projectLocalLibraryManagementEvent(p,event,ledgerRowId);workbench.management.set(event.datasetId,p);
      if(stored)verifyLibraryManagementHistory(db,stored.record,workbench,latest,privateAssets,sourceWrites,ledgerRowId,managementObservations,stored.rootRelinkProof);
      continue;
    }
    if(row.operation===LOCAL_WORKBENCH_JOURNAL_OPERATION){
      const event=readLocalWorkbenchJournalEvent(row),p=workbench.workbench.get(event.datasetId)??emptyLocalWorkbenchJournalProjection(event.datasetId);
      projectLocalWorkbenchJournalEvent(p,event,ledgerRowId);workbench.workbench.set(event.datasetId,p);continue;
    }
    if(row.operation===LOCAL_LYRICS_JOURNAL_OPERATION){
      const event=readLocalLyricsJournalEvent(row),p=workbench.lyrics.get(event.datasetId)??emptyLocalLyricsJournalProjection(event.datasetId);
      projectLocalLyricsJournalEvent(p,event,ledgerRowId);workbench.lyrics.set(event.datasetId,p);continue;
    }
    if(row.operation===LOCAL_LYRICS_PHYSICAL_OPERATION){
      const event=readLocalLyricsPhysicalEvent(row),p=workbench.lyricsPhysical.get(event.datasetId)??emptyLocalLyricsPhysicalProjection(event.datasetId);
      const value=projectLocalLyricsPhysicalEvent(p,event,ledgerRowId);workbench.lyricsPhysical.set(event.datasetId,p);
      if(value&&value.revision===1){lyricsPhysicalOriginalSave(db,workbench,value);verifyLyricsPhysicalInitialHistory(db,value,workbench,latest,privateAssets,relations,sourceWrites,ledgerRowId);}
      if(value&&value.phase==='FACTS_COMMITTED'){const fact=p.records.get(value.operationId)?.publication;if(!fact)return corrupt();verifyLyricsPhysicalPublication(db,value,fact,workbench,ledgerRowId,latest);}
      continue;
    }
    if(row.operation===LOCAL_CUE_OUTPUT_OPERATION){
      const event=readLocalCueOwnerEvent(row),p=workbench.cue.get(event.datasetId)??emptyLocalCueOwnerProjection(event.datasetId);
      projectLocalCueOwnerEvent(p,event,ledgerRowId);workbench.cue.set(event.datasetId,p);continue;
    }
    if(row.operation===LOCAL_SCAN_SETTINGS_OPERATION){
      const event=readLocalScanSettingsOwnerEvent(row),p=workbench.scanSettings.get(event.datasetId)??emptyLocalScanSettingsOwnerProjection(event.datasetId);
      projectLocalScanSettingsOwnerEvent(p,event,ledgerRowId);workbench.scanSettings.set(event.datasetId,p);continue;
    }
    if(row.operation===LOCAL_WORKBENCH_MB_ONLY_OPERATION){
      const e=readLocalWorkbenchMBOnlyEvent(row),p=workbench.mbOnly.get(e.datasetId)??emptyLocalWorkbenchMBOnlyProjection(e.datasetId),value=projectLocalWorkbenchMBOnlyEvent(p,e,ledgerRowId);
      if(value){verifyMBOnlyHistoricalRecord(db,value,workbench,ledgerRowId);for(const update of value.editionUpdates){assertReadActive?.();if(!same(latest.get(`local_catalog_editions:${update.before.id}`),update.before))return corrupt();latest.set(`local_catalog_editions:${update.after.id}`,update.after)}}
      workbench.mbOnly.set(e.datasetId,p);continue;
    }
    if (row.operation === ORGANIZER_JOURNAL) { verifyOrganizerJournalRow(db, row, latest); continue; }
    if(['relink-root','move-asset','replace-asset','select-asset'].includes(String(row.operation)))for(const p of workbench.lyrics.values()){assertReadActive?.();p.inventory.clear();p.highWater=ledgerRowId}
    const operation = row.operation as dto.LocalCatalogOperation;
    if (!(dto.LOCAL_CATALOG_OPERATIONS as readonly unknown[]).includes(operation) || !dto.isCollectionId(row.command_id)
      || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return corrupt();
    const request = parse(row.request, (v): v is Row & { commandId: string } => validRequest(operation, v));
    const result = parse(row.result, (v): v is dto.LocalCatalogResult => dto.isLocalCatalogResult(operation, v));
    if (request.commandId !== row.command_id || fingerprint(operation, request) !== row.fingerprint) return corrupt();
    const id = 'id' in result ? result.id : result.trackId;
    const key = `${resultTable(operation)}:${id}`, previous = latest.get(key);
    if (['register-root', 'register-asset', 'create-track', 'create-edition', 'link-edition-track', 'observe-metadata'].includes(operation) && previous) return corrupt();
    if (['relink-root', 'move-asset', 'replace-asset', 'select-asset', 'remove-edition-track'].includes(operation) && !previous) return corrupt();
    verifyHistoryStep(db, operation, request, result, latest, privateAssets, observations, relations, assertReadActive);
    if(operation==='relink-root'){if(!dto.isLibraryRoot(previous))return corrupt();workbench.rootRelinks.set(id,readRootRelinkReceipt(row,previous));}
    if (operation === 'create-track' || operation === 'select-asset') {
      const selected = result as dto.LocalTrack;
      if (previous && dto.isLocalTrack(previous)) relations.tracks.get(previous.assetId)?.delete(previous.id);
      const members = relations.tracks.get(selected.assetId) ?? new Map<string, dto.LocalTrack>();
      members.set(selected.id, selected); relations.tracks.set(selected.assetId, members);
    }
    if (operation === 'link-edition-track' || operation === 'remove-edition-track') {
      const link = result as dto.AlbumEditionTrack, sequences = relations.editionSequences.get(link.editionId) ?? new Set<number>();
      if (link.active) sequences.add(link.sequence); else sequences.delete(link.sequence);
      relations.editionSequences.set(link.editionId, sequences);
    }
    if (operation === 'register-asset' || operation === 'replace-asset') privateAssets.set(id, { relative: request.relative, sha256: request.sha256 });
    else if (operation === 'move-asset') {
      const old = privateAssets.get(id); if (!old) return corrupt(); privateAssets.set(id, { ...old, relative: request.relative });
    }
    if (operation === 'observe-metadata') {
      // raw永不更新：逐回执按PK核当前行，不在重放Map保留全部raw payload或全部ledger。
      const stored = prepare('SELECT CAST(rowid AS TEXT) AS _observation_rowid,* FROM local_catalog_observations WHERE id=?').get(id);
      if (!stored || stored.id !== id || stored.track_id !== (result as dto.LocalMetadataObservation).trackId
        || !same(parse(stored.data, dto.isLocalMetadataObservation), result)) return corrupt();
      boundedRow({id:stored.id,track_id:stored.track_id,data:stored.data}); immutableObservations++;
      rememberLibraryManagementObservation(managementObservations, result as dto.LocalMetadataObservation, ledgerRowId,
        observationRowId(stored._observation_rowid));
    } else latest.set(key, result);
  }
  // 同一根CAS的全成员位置事实必须齐全；完整READY声明和旧rootRevision不能掩盖部分账本。
  for (const obligation of rootFactsObligations.values()) { assertReadActive?.(); if (obligation.pending.size) return corrupt(); }
  let entities = 0;
  for (const table of Object.keys(tables).filter(name => name !== 'local_catalog_ledger') as Exclude<Table, 'local_catalog_ledger'>[]) {
    for (const row of prepare(`SELECT * FROM ${table}`).iterate()) {
      assertReadActive?.();
      const id = String(table === 'local_catalog_overrides' ? row.track_id : row.id);
      boundedRow(row);
      const stored = latest.get(`${table}:${id}`);
      if (table !== 'local_catalog_observations' && (!stored || !same(JSON.parse(String(row.data)), stored))) return corrupt();
      if (table === 'local_catalog_roots') readRoot(row);
      if (table === 'local_catalog_assets') {
        const asset = readAsset(row), root = prepare('SELECT * FROM local_catalog_roots WHERE id=?').get(asset.libraryRootId);
        if (!root || BigInt(asset.rootRevision) > BigInt(readRoot(root).revision) || !same(privateAssets.get(id), { relative: row.relative, sha256: row.sha256 })) return corrupt();
      }
      if (table === 'local_catalog_tracks') {
        const track = readTrack(row), asset = prepare('SELECT * FROM local_catalog_assets WHERE id=?').get(track.assetId);
        if (!asset) return corrupt(); checkSegment(track, readAsset(asset));
      }
      if (table === 'local_catalog_edition_tracks') {
        const link = parse(row.data, dto.isAlbumEditionTrack); if (row.edition_id !== link.editionId || row.track_id !== link.trackId) return corrupt();
      }
      if (table === 'local_catalog_observations') { const observation = parse(row.data, dto.isLocalMetadataObservation); if (row.track_id !== observation.trackId) return corrupt(); }
      if (table === 'local_catalog_overrides') { const override = parse(row.data, dto.isLocalMetadataOverride); if (row.track_id !== override.trackId) return corrupt(); }
      entities++;
    }
  }
  if (immutableObservations !== counts.get('local_catalog_observations') || entities !== latest.size + immutableObservations || prepare('PRAGMA foreign_key_check').get()
    || prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') return corrupt();
  if (dataVersion(db) !== initialDataVersion || !same(observationHistoryPoint(db),initialObservationPoint)) return corrupt();
  for(const p of workbench.workbench.values()){assertReadActive?.();assertLocalWorkbenchJournalComplete(p);}
  for(const p of workbench.lyrics.values()){assertReadActive?.();assertLocalLyricsJournalComplete(p);}
  for(const p of workbench.cue.values()){assertReadActive?.();assertLocalCueOwnerComplete(p);}
  for(const p of workbench.mbOnly.values()){assertReadActive?.();assertLocalWorkbenchMBOnlyComplete(p);}
  for(const p of workbench.lyricsPhysical.values()){assertReadActive?.();assertLocalLyricsPhysicalComplete(p);}
  for(const p of workbench.management.values()){assertReadActive?.();assertLocalLibraryManagementComplete(p);}
  for(const p of workbench.lyricsRoot.values()){assertReadActive?.();assertLocalLyricsRootComplete(p);}
  workbench.highWater=Number(prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n);
  sourceWrites.highWater=Math.max(sourceWrites.highWater,Number(prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n));
  relocation.highWater = Math.max(relocation.highWater, Number(prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n));
  assertReadActive?.();
  workbenchAudits.set(db,workbench);
  const certificate:AuditCertificate = { rows: counts, bytes, dataVersion: initialDataVersion };
  audits.set(db, certificate);
  legacyAudits.set(db,legacy);
  sourceWritesAudits.set(db,sourceWrites);
  relocationAudits.set(db, relocation);
  if(managementObservations.byTrack!==null)publishObservationHistory(db,certificate,initialObservationPoint,managementObservations);
}

function readLyricsFullRecord(db:DatabaseSync,index:LocalLyricsFullRecordPin):LocalLyricsDurableRecord{
  const parts:Buffer[]=[];let n=0,commit:ReturnType<typeof readLocalLyricsJournalEvent>|null=null
  for(const row of db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE rowid>=? AND rowid<=? ORDER BY rowid').iterate(index.firstOrdinal,index.lastOrdinal)){
    boundedRow(row);const event=readLocalLyricsJournalEvent(row)
    if(event.datasetId!==index.datasetId||event.recordKind!==index.recordKind||event.key!==index.key||event.transactionId!==index.transactionId||event.revision!==index.revision
      ||event.bytes!==index.bytes||event.snapshotHash!==index.snapshotHash||event.chunks!==index.chunks||commit)return corrupt()
    if(event.kind==='record-chunk'){if(event.index!==n)return corrupt();parts.push(Buffer.from(event.payload,'base64'));n++}
    else {if(Number(row._ledger_rowid)!==index.lastOrdinal||n!==index.chunks)return corrupt();commit=event}
  }
  const bytes=Buffer.concat(parts)
  if(!commit||bytes.length!==index.bytes||createHash('sha256').update(bytes).digest('hex')!==index.snapshotHash)return corrupt()
  let value:LocalLyricsDurableRecord
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as LocalLyricsDurableRecord}catch{return corrupt()}
  const current=localLyricsRecordIdentity(index.recordKind,value)
  if(lyricsCanonical(value)!==bytes.toString('utf8')||current.datasetId!==index.datasetId||current.key!==index.key||current.revision!==index.revision||current.immutableHash!==index.immutableHash)return corrupt()
  return value
}
function readLyricsRecord(db:DatabaseSync,index:LocalLyricsRecordIndex):LocalLyricsDurableRecord{
  if(index.recordKind!=='save'||!index.saveState||!index.intentSource)return readLyricsFullRecord(db,index)
  const original=readLyricsFullRecord(db,index.intentSource) as LocalLyricsSaveRecord
  const result:LocalLyricsSaveRecord={intent:original.intent,receipt:structuredClone(index.saveState.receipt),revision:index.revision,physicalClosed:index.saveState.physicalClosed,discarded:index.saveState.discarded}
  assertLocalLyricsSaveRecord(result);return result
}

/** 原捕获与快照必须指向同ledger的作者原件；冷核按当时已投影事实，不拿当前成员覆盖历史。 */
function verifyLyricsRootRecord(db:DatabaseSync,a:WorkbenchAudit,input:LocalLyricsRootRecord,live=false,latest?:ReadonlyMap<string,dto.LocalCatalogResult>):void{
  const r=captureLocalLyricsRootRecord(input);
  const current=(table:'local_catalog_tracks'|'local_catalog_assets'|'local_catalog_roots',id:string)=>db.prepare('SELECT * FROM '+table+' WHERE id=?').get(id)??corrupt();
  if(r.kind==='original-capture'){
    const pin=r.managementCapture,stored=a.management.get(r.datasetId)?.records.get('capture:'+pin.key);
    if(!stored||stored.record.kind!=='capture'||stored.ledgerSequence!==pin.ledgerSequence||stored.recordSha256!==pin.recordSha256||stored.record.originalSha256!==pin.originalSha256)return corrupt();
    const captured=stored.record.original.albums.find(v=>v.libraryId===r.scope.libraryId&&v.resolved.capture.albumId===r.scope.albumId);
    if(!captured||localLibraryManagementDigest(captured.resolved)!==localLibraryManagementDigest(r.resolved)||captured.sourceRootId!==pin.sourceRootId||captured.rootRevision!==pin.rootRevision
      ||(stored.record.original.mode==='library'?stored.record.key!==r.scope.captureId:r.resolved.capture.readToken!==r.scope.captureId))return corrupt();
    for(const m of r.resolved.group.members){const original=r.resolved.capture.members.find(v=>v.trackId===m.fact.summary.track.id);if(!original||original.assetId===null)return corrupt();
      const t=live?readTrack(current('local_catalog_tracks',original.trackId!)):latest?.get('local_catalog_tracks:'+original.trackId),assetValue=live?readAsset(current('local_catalog_assets',original.assetId)):latest?.get('local_catalog_assets:'+original.assetId);
      if(t&&(!dto.isLocalTrack(t)||!same(t,m.fact.summary.track))||assetValue&&(!dto.isAudioAsset(assetValue)||!same(assetValue,m.fact.summary.asset)))return corrupt();
      if(live&&(lyricsDigest(lyricsCanonical(libraryMetadata(db,original.trackId!)))!==original.metadataRevision||readRoot(current('local_catalog_roots',r.scope.libraryId)).revision!==original.rootRevision))throw new LocalLyricsError('STALE');
    }
    return;
  }
  const captured=a.lyricsRoot.get(r.datasetId)?.records.get('original-capture:'+r.original.originalCaptureKey),index=a.lyrics.get(r.datasetId)?.latest.get('save:'+r.key);
  if(!captured||captured.kind!=='original-capture'||!index||index.recordKind!=='save')return corrupt();
  const saved=readLyricsRecord(db,index) as LocalLyricsSaveRecord;assertLocalLyricsSaveRecord(saved);
  if(!same(saved.intent.request,r.original.request)||!same(saved.intent.scope,r.original.scope)||saved.intent.captureFingerprint!==captured.fingerprint||captured.fingerprint!==r.original.captureSha256
    ||lyricsPhysicalDigest(saved.intent)!==r.original.intentSha256||!same(captured.scope,r.original.scope))return corrupt();
  const physical=a.lyricsPhysical.get(r.datasetId),last=r.attempts.at(-1)!;
  for(const pin of last.publicationPins){const item=physical?.records.get(pin.operationId),record=item?.record,publication=item?.publication;
    if(!item||!record||!publication||record.binding.commandId!==r.key||record.phase!=='CLOSED'||!record.physicalClosed||!record.protectionReleased||record.unresolved
      ||!['saved','existing'].includes(String(record.result?.state))||item.ledgerSequence!==pin.ledgerSequence||item.publicationSequence!==pin.publicationSequence||record.revision!==pin.revision
      ||lyricsPhysicalDigest(record)!==pin.recordSha256||lyricsPhysicalDigest(publication)!==pin.publicationSha256)return corrupt();
    lyricsPhysicalOriginalSave(db,a,record);
  }
  if(last.phase==='SAVED'){
    const all=[...(physical?.records.values()??[])].filter(v=>v.record.binding.commandId===r.key),closed=all.filter(v=>v.record.phase==='CLOSED');
    if(all.some(v=>!['CLOSED','FAILED'].includes(v.record.phase)||!v.record.physicalClosed||!v.record.protectionReleased||v.record.unresolved)||closed.length!==last.publicationPins.length
      ||closed.some(v=>!last.publicationPins.some(p=>p.operationId===v.record.operationId))||!last.observations||!last.resources)return corrupt();
    const ids=captured.resolved.group.members.map(v=>v.fact.summary.track.id);
    if(last.observations.length!==ids.length||last.observations.some(v=>!ids.includes(v.trackId))||last.resources.length!==captured.resources.length
      ||last.resources.some(v=>!captured.resources.some(p=>p.rootId===v.rootId&&p.relative===v.relative)))return corrupt();
    for(const observation of last.observations){const original=captured.resolved.group.members.find(v=>v.fact.summary.track.id===observation.trackId)!,assetValue=live?readAsset(current('local_catalog_assets',original.fact.summary.asset.id)):latest?.get('local_catalog_assets:'+original.fact.summary.asset.id);
      if(assetValue&&(!dto.isAudioAsset(assetValue)||assetValue.fileRevision!==observation.fileRevision))return corrupt();
      if(live&&(lyricsDigest(lyricsCanonical(libraryMetadata(db,observation.trackId)))!==captured.resolved.capture.members.find(m=>m.trackId===observation.trackId)!.metadataRevision))throw new LocalLyricsError('STALE');
    }
  }
}

function lyricsPhysicalOriginalSave(db:DatabaseSync,a:WorkbenchAudit,r:LocalLyricsPhysicalRecord):LocalLyricsSaveRecord{
  const b=r.binding,index=a.lyrics.get(b.datasetId)?.latest.get(`save:${b.commandId}`);
  if(!index||index.recordKind!=='save')throw new LocalLyricsError('NOT_FOUND');
  const saved=readLyricsRecord(db,index) as LocalLyricsSaveRecord;assertLocalLyricsSaveRecord(saved);
  const intent=saved.intent,selected=intent.selected.find(s=>s.track.trackId===b.trackId);
  if(!selected||saved.discarded||intent.scope.datasetId!==b.datasetId||intent.scope.libraryId!==b.libraryId||intent.scope.albumId!==b.albumId||intent.scope.captureId!==b.captureId
    ||intent.request.commandId!==b.commandId||intent.request.sessionId!==b.sessionId||intent.fingerprint!==b.intentFingerprint||selected.candidateId!==b.candidateId||selected.sha256!==b.bodySha256
    ||lyricsDigest(selected.body)!==b.bodySha256||lyricsPhysicalDigest(intent)!==b.originalIntentSha256||lyricsPhysicalDigest(intent.request)!==b.originalRequestSha256
    ||intent.captureFingerprint!==b.groupCaptureSha256||lyricsPhysicalDigest(r.original)!==b.protectionSha256||b.memberCount!==r.original.members.length||b.resourceCount!==r.original.resources.length
    ||b.targetCount!==intent.selected.length*(intent.request.embed?2:1)||b.kind==='embed'&&!intent.request.embed
    ||['rootRevision','fileRevision','locationRevision','metadataRevision'].some(k=>selected.track[k as keyof typeof selected.track]!==b[k as keyof typeof b]))throw new LocalLyricsError('STALE');
  for(const item of intent.selected){const m=r.original.members.find(m=>m.trackId===item.track.trackId);
    if(!m||m.rootId!==b.libraryId||['rootRevision','fileRevision','locationRevision','metadataRevision'].some(k=>m[k as keyof typeof m]!==item.track[k as keyof typeof item.track]))throw new LocalLyricsError('STALE');
  }
  return saved;
}
function lyricsPhysicalOwnAsset(r:LocalLyricsPhysicalRecord,a:WorkbenchAudit,assetId:string,originalRevision:string):{revision:string;sha256:string|null;target:LocalLyricsPhysicalRecord['artifacts']['target']} {
  let revision=originalRevision,sha256:string|null=null,target:LocalLyricsPhysicalRecord['artifacts']['target']=null;
  const publications=[...(a.lyricsPhysical.get(r.binding.datasetId)?.records.values()??[])].filter(item=>item.publication?.replace?.after.id===assetId
    &&item.record.binding.commandId===r.binding.commandId&&item.record.binding.originalIntentSha256===r.binding.originalIntentSha256
    &&item.record.binding.groupCaptureSha256===r.binding.groupCaptureSha256&&item.record.result?.state==='saved'
    &&(item.record.operationId===r.operationId?['FACTS_COMMITTED','QUIET','CLOSED'].includes(item.record.phase):item.record.phase==='CLOSED'))
    .sort((a,b)=>a.publicationSequence!-b.publicationSequence!);
  for(const item of publications){const fact=item.publication!.replace!;
    if(fact.before.fileRevision!==revision)throw new LocalLyricsError('STALE');
    revision=fact.after.fileRevision;target=item.record.artifacts.target;if(!target)throw new LocalLyricsError('STALE');sha256=target.sha256;
  }
  return {revision,sha256,target};
}
function verifyLyricsPhysicalInitialHistory(db:DatabaseSync,r:LocalLyricsPhysicalRecord,a:WorkbenchAudit,latest:ReadonlyMap<string,dto.LocalCatalogResult>,locations:ReadonlyMap<string,{relative:unknown;sha256:unknown}>,relations:HistoryRelations,source:SourceWritesProjection,sequence:number):void{
  const checked=new Set<string>();
  for(const member of r.original.members){const track=latest.get(`local_catalog_tracks:${member.trackId}`),asset=latest.get(`local_catalog_assets:${member.fileId}`),root=latest.get(`local_catalog_roots:${member.rootId}`),resource=r.original.resources[member.resourceIndex]!,location=locations.get(member.fileId),own=lyricsPhysicalOwnAsset(r,a,member.fileId,member.fileRevision);
    if(!dto.isLocalTrack(track)||track.assetId!==member.fileId||!dto.isAudioAsset(asset)||!dto.isLibraryRoot(root)||root.id!==r.binding.libraryId||root.revision!==member.rootRevision
      ||root.sourceRootId!==member.sourceRootId||asset.libraryRootId!==root.id||asset.sourceRootId!==member.sourceRootId||asset.rootRevision!==member.rootRevision||asset.fileRevision!==own.revision||asset.locationRevision!==member.locationRevision
      ||!location||location.relative!==resource.relative||location.sha256!==null&&location.sha256!==(own.sha256??resource.sha256)||own.target&&lyricsPhysicalDigest(own.target)!==lyricsPhysicalDigest(resource))return corrupt();
    if(!checked.has(asset.id)){checked.add(asset.id);const original=r.original.members.filter(m=>m.fileId===asset.id),actual=relations.tracks.get(asset.id);
      if(!actual||actual.size!==original.length||original.some(m=>!actual.has(m.trackId)))return corrupt();
    }
    const anchor=source.fullRaw.get(member.trackId),raw:dto.LocalMetadata={...anchor?.fields};
    const rows=db.prepare("SELECT o.data FROM local_catalog_observations o WHERE o.track_id=? AND EXISTS(SELECT 1 FROM local_catalog_ledger l WHERE l.operation='observe-metadata' AND json_extract(l.result,'$.id')=o.id AND l.rowid<=? AND l.rowid>?) ORDER BY o.rowid LIMIT 201").all(member.trackId,sequence,anchor?.ledgerOrdinal??0);
    if(rows.length>200)return corrupt();for(const row of rows)Object.assign(raw,parse(row.data,dto.isLocalMetadataObservation).fields);
    const override=latest.get(`local_catalog_overrides:${member.trackId}`)??null;if(override!==null&&!dto.isLocalMetadataOverride(override))return corrupt();
    const view={raw,override,effective:dto.mergeLocalMetadata(raw,override?.fields)};if(lyricsDigest(lyricsCanonical(view))!==member.metadataRevision)return corrupt();
  }
}
/** 冷读核实际子账本，而不是相信一个FACTS_COMMITTED状态词。 */
function verifyLyricsPhysicalPublication(db:DatabaseSync,r:LocalLyricsPhysicalRecord,f:LocalLyricsPhysicalPublication,a:WorkbenchAudit,sequence:number,latest?:ReadonlyMap<string,dto.LocalCatalogResult>):void{
  const b=r.binding,saved=lyricsPhysicalOriginalSave(db,a,r),member=r.original.members.find(m=>m.trackId===b.trackId),target=r.artifacts.target;
  if(!member||!target||f.datasetId!==b.datasetId||f.operationId!==r.operationId||!['saved','existing'].includes(String(r.result?.state))||r.result?.bodySha256!==b.bodySha256)return corrupt();
  const resource=r.original.resources[member.resourceIndex]!;
  if(target.rootId!==resource.rootId||b.kind==='lrc'&&target.sha256!==b.bodySha256)return corrupt();
  if(b.kind==='embed'){
    const replace=f.replace,scan=f.scan,fidelity=r.fidelity;if(!replace||!scan||!fidelity||fidelity.sourceSha256!==resource.sha256||fidelity.copySha256!==target.sha256
      ||replace.before.id!==member.fileId||replace.before.libraryRootId!==member.rootId||replace.after.id!==replace.before.id||replace.relative!==resource.relative
      ||target.relative!==resource.relative||scan.rootId!==member.rootId||scan.relative!==resource.relative)return corrupt();
    const row=db.prepare('SELECT rowid AS sequence,* FROM local_catalog_ledger WHERE command_id=?').get(replace.commandId);
    if(!row||row.operation!=='replace-asset'||Number(row.sequence)!==replace.ledgerSequence||replace.ledgerSequence>=sequence)return corrupt();
    boundedRow(row);const request=JSON.parse(String(row.request)) as ReplaceAudioAsset;
    if(!validRequest('replace-asset',request)||request.commandId!==replace.commandId||fingerprint('replace-asset',request)!==row.fingerprint||!same(JSON.parse(String(row.result)),replace.after)
      ||request.assetId!==replace.before.id||request.libraryRootId!==member.rootId||request.relative!==resource.relative||request.sha256!==target.sha256
      ||request.expectedFileRevision!==replace.before.fileRevision||request.expectedLocationRevision!==replace.before.locationRevision||request.expectedRootRevision!==member.rootRevision
      ||!same(replace.after,{...replace.before,fileRevision:next(replace.before.fileRevision)}))return corrupt();
    if(latest&&!same(latest.get(`local_catalog_assets:${replace.after.id}`),replace.after))return corrupt();
    let before:Row,after:Row;try{before=JSON.parse(scan.before) as Row;after=JSON.parse(scan.after) as Row;}catch{return corrupt();}
    if(before.libraryRootId!==member.rootId||before.relative!==resource.relative||before.assetId!==member.fileId||before.signature!==resource.signature
      ||!same(after,{...before,signature:target.signature}))return corrupt();
  }else if(f.replace||f.scan)return corrupt();
  const inventoryIdentity=localLyricsRecordIdentity('inventory',f.inventory.record),index=a.lyrics.get(b.datasetId)?.latest.get(`inventory:${inventoryIdentity.key}`);
  if(!index||index.lastOrdinal!==f.inventory.ledgerSequence||index.lastOrdinal>=sequence||!same(readLyricsRecord(db,index),f.inventory.record)
    ||!same(f.inventory.record.scope,saved.intent.scope)||f.inventory.record.captureFingerprint!==b.groupCaptureSha256
    ||f.inventory.record.observations.length!==r.original.members.length)return corrupt();
  const byTrack=new Map(f.inventory.record.observations.map(o=>[o.trackId,o]));
  for(const m of r.original.members){const observation=byTrack.get(m.trackId),own=lyricsPhysicalOwnAsset(r,a,m.fileId,m.fileRevision);
    if(!observation||observation.fileRevision!==own.revision||m.resourceIndex===member.resourceIndex&&(b.kind==='lrc'?observation.lrc:observation.embedded)!=='true')return corrupt();
  }
}

const mbOnlyCatalogOwners=new WeakMap<object,(identity:DatasetIdentity)=>void>();
export function assertLocalWorkbenchCatalogOwner(catalog:object,identity:DatasetIdentity):void{const check=mbOnlyCatalogOwners.get(catalog);if(!check)throw new LocalLyricsError('STALE');check(identity)}
function verifyMBOnlyHistoricalRecord(db:DatabaseSync,value:LocalWorkbenchMBOnlyRecord,a:WorkbenchAudit,sequence:number):void{
  const originalProjection=a.workbench.get(value.request.datasetId),entry=originalProjection?.snapshot?.entries.find(e=>e.plan.planId===value.request.planId)
  if(!entry||!same(entry.plan,value.plan)||!same(entry.capture,value.capture)||!same(entry.original,value.request))return corrupt()
  for(const m of value.mutations){const row=db.prepare('SELECT rowid AS sequence,* FROM local_catalog_ledger WHERE command_id=?').get(m.commandId)
    if(!row||row.operation!==m.operation||String(row.sequence)!==m.sequence||Number(row.sequence)>=sequence||Number(row.sequence)<=originalProjection!.highWater||!same(JSON.parse(String(row.request)),m.request)||!same(JSON.parse(String(row.result)),m.result))return corrupt();boundedRow(row);if(!validRequest(m.operation,m.request)||m.request.commandId!==m.commandId||fingerprint(m.operation,m.request)!==row.fingerprint)return corrupt()}
  for(const art of value.artwork){const row=db.prepare('SELECT fingerprint,result FROM local_artwork_ledger WHERE command_id=?').get(art.commandId);if(!row||!same(JSON.parse(String(row.result)),art.selection)||art.selection.editionId!==art.editionId)return corrupt()
    const frozen=value.capture.artwork?.find(i=>i.albumId===art.albumId),selected=art.selection.candidate;if(!frozen||!selected||!same(selected.original,frozen.image.original)||!same(selected.display,frozen.image.display)||selected.origin!==frozen.origin||selected.sourceLabel!==frozen.sourceLabel
      ||selected.sourceIdentity!==createHash('sha256').update(JSON.stringify([frozen.sourceIdentity??null,frozen.candidateId,frozen.image.original.sha256])).digest('hex')
      ||row.fingerprint!==createHash('sha256').update(localWorkbenchJournalCanonical(['mb-only-artwork',art.editionId,frozen,selected.remoteSource??null])).digest('hex'))return corrupt()}
  for(const source of value.provenance){const child=value.mutations.find(m=>m.commandId===source.commandId);if(!child||child.operation!=='override-metadata'||!dto.isLocalMetadataOverride(child.result)||child.result.trackId!==source.trackId||child.result.revision!==source.revision||!same(child.result.fields,source.fields))return corrupt()}
}

/** SQLite的规范有符号64位文本只转bigint，不经可能舍入的JS number。 */
function observationRowId(value:unknown):bigint|undefined {
  if(typeof value!=='string'||value.length>20||!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/u.test(value))return undefined;
  const rowId=BigInt(value);
  return rowId>=-9223372036854775808n&&rowId<=9223372036854775807n?rowId:undefined;
}
/** 冷核按ID点读验证后只保同DB的[精确rowid,ledger序号]对，不保观察ID副本或raw正文。 */
interface LibraryManagementObservationHistory {
  byTrack: Map<string, (bigint|number)[] | null> | null;
  allocationBytes: number;
}
function rememberLibraryManagementObservation(history:LibraryManagementObservationHistory, observation:dto.LocalMetadataObservation, sequence:number,rowId:bigint|undefined):void {
  const byTrack=history.byTrack;if(byTrack===null)return;
  const previous=byTrack.get(observation.trackId);if(previous===null)return;
  // 每曲候选至多201；超过后该曲走原SQL，以保fullRaw anchor可裁掉任意旧观察的语义。
  if(previous&&previous.length===201*2){byTrack.set(observation.trackId,null);return;}
  // 每对按96字节覆盖bigint/数字装箱、数组槽及增长余量；原Map/每track192字节和32MiB总限额保留。
  const allocation=(rowId===undefined?0:96)+(previous===undefined?192+2*observation.trackId.length:0);
  if(history.allocationBytes+allocation>32*1024*1024){byTrack.clear();history.byTrack=null;return;}
  history.allocationBytes+=allocation;
  if(rowId===undefined){byTrack.set(observation.trackId,null);return;}
  if(previous)previous.push(rowId,sequence);else byTrack.set(observation.trackId,[rowId,sequence]);
}
function libraryManagementObservationRows(db:DatabaseSync,history:LibraryManagementObservationHistory,trackId:string,anchor:number,sequence:number):Row[]|undefined {
  const byTrack=history.byTrack;if(byTrack===null)return undefined;
  const candidates=byTrack.get(trackId);if(candidates===null)return undefined;
  const selected:bigint[]=[];
  for(let i=0;i<(candidates?.length??0);i+=2){
    const rowId=candidates![i],ordinal=candidates![i+1];
    if(typeof rowId!=='bigint'||typeof ordinal!=='number')return corrupt();
    if(ordinal>anchor&&ordinal<sequence)selected.push(rowId);
  }
  if(selected.length>200)return corrupt();if(selected.length===0)return [];
  // rowid来自本冷核的真实ID点读；原观察顺序仍由SQLite ORDER BY维护，不能换ledger顺序。
  const rows=db.prepare(`SELECT o.data FROM local_catalog_observations o WHERE o.track_id=? AND o.rowid IN (${selected.map(()=>'?').join(',')}) ORDER BY o.rowid LIMIT 201`).all(trackId,...selected);
  if(rows.length!==selected.length)return corrupt();return rows;
}
function libraryManagementMetadataAt(db:DatabaseSync,trackId:string,latest:ReadonlyMap<string,dto.LocalCatalogResult>,source:SourceWritesProjection,sequence:number,history:LibraryManagementObservationHistory):dto.LocalMetadataView {
  const anchor=source.fullRaw.get(trackId),raw:dto.LocalMetadata={...anchor?.fields};
  const rows=libraryManagementObservationRows(db,history,trackId,anchor?.ledgerOrdinal??0,sequence)
    ?? db.prepare("SELECT o.data FROM local_catalog_observations o WHERE o.track_id=? AND EXISTS(SELECT 1 FROM local_catalog_ledger l WHERE l.operation='observe-metadata' AND json_extract(l.result,'$.id')=o.id AND l.rowid<? AND l.rowid>?) ORDER BY o.rowid LIMIT 201").all(trackId,sequence,anchor?.ledgerOrdinal??0);
  if(rows.length>200)return corrupt();for(const row of rows)Object.assign(raw,parse(row.data,dto.isLocalMetadataObservation).fields);
  const override=latest.get(`local_catalog_overrides:${trackId}`)??null;if(override!==null&&!dto.isLocalMetadataOverride(override))return corrupt();
  return {raw,override,effective:dto.mergeLocalMetadata(raw,override?.fields)};
}
function libraryManagementGroupKey(rootId:string,editionId:string|null,relative:string,raw:dto.LocalMetadata):string {
  const directory=path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative);
  const versions=[...new Set(libraryVersionTokens(raw).filter(v=>v.source==='album'&&(v.kind==='edition'||v.kind==='format')).map(v=>v.raw))].sort();
  const values=editionId?[rootId,editionId]:[rootId,directory,directory===''?'':(raw.album??'').trim(),directory===''?[]:versions];
  return (editionId?'edition-':'directory-')+createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
/** 只核同连接原source.authorize与register-root回执，不能从Root UUID或JSON自造目录资格。 */
function verifyLibraryManagementImportReceipt(db:DatabaseSync,value:LocalLibraryManagementOperationRecord,beforeSequence?:number):void {
  if(value.original.command!=='library.import.confirm'||value.receipt.state!=='succeeded'||value.revision===1)return
  if(value.receipt.libraryIds.length!==1)return corrupt()
  const row=db.prepare('SELECT rowid ordinal,* FROM local_catalog_ledger WHERE command_id=?').get(value.key)
  if(!row||row.operation!=='register-root'||beforeSequence!==undefined&&Number(row.ordinal)>=beforeSequence)return corrupt()
  boundedRow(row)
  const request=parse(row.request,(v):v is Row & {commandId:string}=>validRequest('register-root',v)),result=parse(row.result,dto.isLibraryRoot)
  if(request.commandId!==value.key||request.role!=='library'||result.role!=='library'||request.sourceRootId!==result.sourceRootId||value.receipt.libraryIds[0]!==result.id
    ||row.fingerprint!==fingerprint('register-root',request))return corrupt()
  const original=db.prepare('SELECT fingerprint,result FROM source_ledger WHERE command_id=?').get(value.key)
  if(!original||original.fingerprint!==createHash('sha256').update(JSON.stringify(['authorize',value.key])).digest('hex')||original.result!==result.sourceRootId)return corrupt()
}
function readRootRelinkReceipt(row:Row,beforeRoot?:dto.LibraryRoot):RootRelinkReceipt {
  boundedRow(row);if(row.operation!=='relink-root')return corrupt();
  const request=parse(row.request,(v):v is Row & {commandId:string}=>validRequest('relink-root',v));
  const result=parse(row.result,dto.isLibraryRoot),sequence=Number(row._ledger_rowid??row.ordinal);
  if(request.commandId!==row.command_id||row.fingerprint!==fingerprint('relink-root',request)
    ||typeof row.created_at!=='string'||!Number.isFinite(Date.parse(row.created_at))||!Number.isSafeInteger(sequence)||sequence<1)return corrupt();
  if(beforeRoot&&(request.rootId!==beforeRoot.id||request.expectedRevision!==beforeRoot.revision))return corrupt();
  return {commandId:String(row.command_id),ledgerSequence:String(sequence),requestFingerprint:String(row.fingerprint),request:request as unknown as RelinkLibraryRoot,result,...(beforeRoot?{beforeRoot}:{})};
}
/** 原SQL回执及顺序必须吻合；帧里的Root和摘要不能签发一次新的重关联。 */
function verifyLibraryManagementRootRelinkReceipt(db:DatabaseSync,proof:LocalLibraryManagementRootRelinkProof,beforeSequence?:number):void {
  const row=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE command_id=?').get(proof.commandId);
  if(!row)return corrupt();const actual=readRootRelinkReceipt(row),request=actual.request;
  if(actual.ledgerSequence!==proof.ledgerSequence||actual.requestFingerprint!==proof.requestFingerprint
    ||beforeSequence!==undefined&&Number(actual.ledgerSequence)>=beforeSequence||!same(actual.result,proof.afterRoot)
    ||request.rootId!==proof.beforeRoot.id||request.expectedRevision!==proof.beforeRoot.revision
    ||request.sourceRootId!==proof.afterRoot.sourceRootId||request.role!=='library'||proof.beforeRoot.role!=='library')return corrupt();
}
/** 当序真实管理绑定只决定组织边界，SourceRoot角色/资产许可仍由原ledger事实核验。 */
function libraryManagementRolesAt(value:LocalLibraryManagementCaptureRecord,a:WorkbenchAudit):ReadonlyMap<string,dto.LocalLibraryRole> {
  const roles=new Map<string,dto.LocalLibraryRole>(),records=a.management.get(value.datasetId)?.records;
  for(const pin of value.original.libraries){
    const record=records?.get('binding:'+pin.libraryId)?.record;if(!record)continue;
    if(record.kind!=='binding'||!record.active||record.datasetId!==value.datasetId||record.key!==pin.libraryId
      ||record.sourceRootId!==pin.sourceRootId||record.rootRevision!==pin.rootRevision
      ||!['catalog','artist','album','container'].includes(record.role))return corrupt();
    roles.set(pin.libraryId,record.role);
  }
  return roles;
}
/** 输入来自当序latest/privateAssets全集，不按capture自报的albumId划分或猜当前track。 */
function libraryManagementOrganizationBoundaries(latest:ReadonlyMap<string,dto.LocalCatalogResult>,locations:ReadonlyMap<string,{relative:unknown;sha256:unknown}>,
  roots:ReadonlySet<string>,roles:ReadonlyMap<string,dto.LocalLibraryRole>) {
  if(![...roles.values()].includes('artist'))return new Map<string,ReadonlyMap<string,string>>();
  function* audio(){for(const candidate of latest.values()){
    if(!dto.isLocalTrack(candidate))continue;const asset=latest.get(`local_catalog_assets:${candidate.assetId}`),location=locations.get(candidate.assetId);
    if(!dto.isAudioAsset(asset)||!roots.has(asset.libraryRootId)||roles.get(asset.libraryRootId)!=='artist')continue;
    if(!location||typeof location.relative!=='string')return corrupt();
    yield {rootId:asset.libraryRootId,assetId:asset.id,relative:location.relative};
  }}
  return localAlbumOrganizationDirectoryBoundaries(audio(),roles);
}
function libraryManagementOrganizedGroupKey(rootId:string,editionId:string|null,relative:string,raw:dto.LocalMetadata,
  roles:ReadonlyMap<string,dto.LocalLibraryRole>,boundaries:ReadonlyMap<string,ReadonlyMap<string,string>>):string {
  const role=roles.get(rootId);
  // 原edition及catalog/container/无绑定算法保持原字节，不将组织目录当Source许可。
  if(editionId!==null||role!=='artist'&&role!=='album')return libraryManagementGroupKey(rootId,editionId,relative,raw);
  const physical=path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative);
  const directory=role==='album'?'':boundaries.get(rootId)?.get(physical);if(directory===undefined)return corrupt();
  return 'directory-'+localLibraryManagementDigest([rootId,directory,'',[]]);
}
function verifyLibraryManagementHistory(db:DatabaseSync,value:LocalLibraryManagementRecord,a:WorkbenchAudit,latest:ReadonlyMap<string,dto.LocalCatalogResult>,locations:ReadonlyMap<string,{relative:unknown;sha256:unknown}>,source:SourceWritesProjection,sequence:number,history:LibraryManagementObservationHistory,rootRelinkProof?:LocalLibraryManagementRootRelinkProof):void {
  if(value.kind==='binding'){
    const root=latest.get(`local_catalog_roots:${value.libraryId}`);
    if(rootRelinkProof){verifyLibraryManagementRootRelinkReceipt(db,rootRelinkProof,sequence);
      const original=a.rootRelinks.get(value.libraryId);
      if(!same(root,rootRelinkProof.afterRoot)||original?.commandId!==rootRelinkProof.commandId||!same(original.beforeRoot,rootRelinkProof.beforeRoot))return corrupt();}
    if(!dto.isLibraryRoot(root)||root.role!=='library'||(value.active||value.revision===1)&&(root.sourceRootId!==value.sourceRootId||root.revision!==value.rootRevision))return corrupt();return;
  }
  if(value.kind==='job'){assertLibraryManagementJobCapture(value,a.management.get(value.datasetId));assertLibraryManagementJobReceipts(value,a);return;}
  if(value.kind==='operation'){verifyLibraryManagementImportReceipt(db,value,sequence);return;}
  if(value.kind!=='capture')return;
  const original=value.original;
  for(const pin of original.libraries){const root=latest.get(`local_catalog_roots:${pin.libraryId}`);if(!dto.isLibraryRoot(root)||root.role!=='library'||root.revision!==pin.rootRevision||root.sourceRootId!==pin.sourceRootId)return corrupt();}
  const capturedTrackIds=new Set<string>(),actualGroups=new Map<string,Set<string>>(),roots=new Set(original.libraries.map(p=>p.libraryId)),linksByTrack=new Map<string,dto.AlbumEditionTrack[]>();
  const roles=libraryManagementRolesAt(value,a),boundaries=libraryManagementOrganizationBoundaries(latest,locations,roots,roles);
  for(const v of latest.values())if(dto.isAlbumEditionTrack(v)&&v.active){const links=linksByTrack.get(v.trackId)??[];links.push(v);linksByTrack.set(v.trackId,links);}
  for(const candidate of latest.values()){
    if(!dto.isLocalTrack(candidate))continue;
    const asset=latest.get(`local_catalog_assets:${candidate.assetId}`),location=locations.get(candidate.assetId);
    if(!dto.isAudioAsset(asset)||!roots.has(asset.libraryRootId)||!location||typeof location.relative!=='string')continue;
    const view=libraryManagementMetadataAt(db,candidate.id,latest,source,sequence,history);
    const links=linksByTrack.get(candidate.id)??[];
    for(const editionId of links.length?links.map(l=>l.editionId):[null]){const key=libraryManagementOrganizedGroupKey(asset.libraryRootId,editionId,location.relative,view.raw,roles,boundaries),ids=actualGroups.get(key)??new Set<string>();ids.add(candidate.id);actualGroups.set(key,ids);}
  }
  for(const album of original.albums){
    const resolved=album.resolved, group=resolved.group, accepted=resolved.capture.members.filter(m=>m.trackId!==null);
    const actual=actualGroups.get(group.summary.id)??new Set<string>();
    if(actual.size!==accepted.length||accepted.some(m=>!actual.has(m.trackId!)))return corrupt();
    for(const member of group.members){
      const fact=member.fact,track=latest.get(`local_catalog_tracks:${fact.summary.track.id}`),asset=latest.get(`local_catalog_assets:${fact.summary.asset.id}`),location=locations.get(fact.summary.asset.id);
      if(!same(track,fact.summary.track)||!same(asset,fact.summary.asset)||location?.relative!==fact.relative)return corrupt();
      const view=libraryManagementMetadataAt(db,fact.summary.track.id,latest,source,sequence,history),capture=accepted.find(m=>m.trackId===fact.summary.track.id)!;
      if(!same(view.raw,fact.rawMetadata)||!same(view.effective,fact.summary.metadata)||localLibraryManagementDigest(view)!==capture.metadataRevision)return corrupt();
      const origin=resolved.provenance.find(p=>p.trackId===fact.summary.track.id)!;
      if(view.override===null?origin.override!==null:origin.override===null||origin.override.revision!==view.override.revision||!same(origin.override.fields,view.override.fields))return corrupt();
      if(origin.override){const row=db.prepare("SELECT rowid n,* FROM local_catalog_ledger WHERE command_id=?").get(origin.override.commandId);
        if(!row||Number(row.n)>=sequence||row.operation!=='override-metadata'||!same(parse(row.result,dto.isLocalMetadataOverride),view.override))return corrupt();}
      capturedTrackIds.add(fact.summary.track.id);
    }
    for(const cue of resolved.directoryFacts.cues){const row=db.prepare('SELECT data FROM local_cue_sources WHERE id=?').get(cue.id);if(!row||!same(readLocalAlbumCueSnapshot(row.data),cue))return corrupt();}
    for(const file of resolved.directoryFacts.files){
      const batches=db.prepare("SELECT result FROM local_scan_batches WHERE job_id=? AND phase='committed' ORDER BY rowid DESC").iterate(file.jobId);let found=false;
      for(const row of batches){if(typeof row.result!=='string'||Buffer.byteLength(row.result)>32*1024*1024)return corrupt();const batch:unknown=JSON.parse(row.result);if(!isScanCommittedBatch(batch))return corrupt();const initial=batch.files.find(f=>f.relative===file.value.relative&&f.libraryRootId===file.value.libraryRootId);if(!initial)continue;
        let current=initial;const updates:{before:string;after:string;sequence:number}[]=[];
        for(const event of source.events){if(event.kind!=='facts'||event.fact.scanJobId!==file.jobId||event.fact.scanBefore===null)continue;const before=parse(event.fact.scanBefore,isScanFileState);if(before.libraryRootId!==file.value.libraryRootId||before.relative!==file.value.relative)continue;const ordinal=Number(db.prepare('SELECT rowid n FROM local_catalog_ledger WHERE command_id=?').get(event.eventId)?.n);if(ordinal<sequence)updates.push({before:event.fact.scanBefore,after:event.fact.scanAfter,sequence:ordinal});}
        for(const p of a.lyricsPhysical.values())for(const item of p.records.values()){const scan=item.publication?.scan;if(scan&&scan.jobId===file.jobId&&scan.rootId===file.value.libraryRootId&&scan.relative===file.value.relative&&item.publicationSequence!==null&&item.publicationSequence<sequence)updates.push({before:scan.before,after:scan.after,sequence:item.publicationSequence});}
        for(const update of updates.sort((x,y)=>x.sequence-y.sequence)){if(!same(parse(update.before,isScanFileState),current))return corrupt();current=parse(update.after,isScanFileState);}
        if(same(current,file.value)){found=true;break;}
      }
      if(!found)return corrupt();
    }
  }
  if(original.mode==='library'){
    for(const [key,ids]of actualGroups){if(!original.albumRefs.some(ref=>ref.albumId===key)||[...ids].some(id=>!capturedTrackIds.has(id)))return corrupt();}
  }
}
function assertLibraryManagementJobReceipts(record:LocalLibraryManagementJobRecord,a:WorkbenchAudit):void {
  for(const item of record.checkpoint.items){if(item.receipt===null)continue;const entry=a.workbench.get(record.datasetId)?.snapshot?.entries.find(e=>e.plan.planId===item.planId&&e.original?.commandId===item.commandId);
    const mb=a.mbOnly.get(record.datasetId)?.latest.get(item.commandId!)?.record,cue=a.cue.get(record.datasetId)?.output.latest.get(item.commandId!)?.record;
    if(!same(entry?.receipt,item.receipt)&&!same(mb?.receipt,item.receipt)&&!same(cue?.receipt,item.receipt))return corrupt();}
}
function assertLibraryManagementJobCapture(record:LocalLibraryManagementJobRecord,p:LocalLibraryManagementProjection|undefined):void {
  const capture=p?.records.get(`capture:${record.original.captureId}`)?.record;
  if(capture?.kind!=='capture'||capture.originalSha256!==record.original.captureSha256)return corrupt();
  if(record.revision===1)for(const pin of capture.original.libraries){const bound=p?.records.get('binding:'+pin.libraryId)?.record;if(bound?.kind==='binding'&&(!bound.active||bound.sourceRootId!==pin.sourceRootId||bound.rootRevision!==pin.rootRevision))return corrupt();}
  const selected=record.original.expandedSelection;
  if(selected.some(ref=>!capture.original.albumRefs.some(a=>same(a,{albumId:ref.albumId,rootId:ref.rootId,revision:ref.revision}))))return corrupt();
  const start=record.original.start;
  if(start.command==='library.ai.start'&&start.request.selection==='missing-cover'){
    const expected=capture.original.albums.filter(a=>a.resolved.group.summary.statuses.includes('missing-artwork')).map(a=>a.resolved.capture.albumId);
    if(!same(selected.map(s=>s.albumId),expected))return corrupt();
  }
  if(start.command==='library.cue.start'){
    const eligible=capture.original.albums.flatMap(a=>a.resolved.directoryFacts.cues.filter(c=>{const r=c.item.result;if(a.resolved.availability!=='online'||c.item.outcome!=='accepted'||!r||!a.resolved.group.issues.some(i=>i.kind==='cue'&&i.relative===c.item.relative)||new Set(r.tracks.map(t=>t.assetReference.assetId)).size===r.tracks.length)return false;return r.tracks.every(t=>{const ref=t.assetReference,m=a.resolved.capture.members.find(m=>m.assetId===ref.assetId),file=a.resolved.directoryFacts.files.find(f=>f.currentRelative===ref.relative);return ref.libraryRootId===a.libraryId&&ref.sourceRootId===a.sourceRootId&&ref.rootRevision===a.rootRevision&&m!==undefined&&m.fileRevision===ref.fileRevision&&m.locationRevision===ref.locationRevision&&file?.value.outcome==='accepted'&&file.value.assetId===ref.assetId&&file.value.signature===ref.signature;});}).map(c=>({albumId:a.resolved.capture.albumId,cueId:c.id})));
    if(start.request.selection==='selected'){if(selected.some(s=>!eligible.some(c=>c.albumId===s.albumId&&c.cueId===s.cueId)))return corrupt();}
    else{const albums=capture.original.albums.filter(a=>a.resolved.group.summary.statuses.includes('cue-unsplit'));if(!same(selected.map(s=>s.albumId),albums.map(a=>a.resolved.capture.albumId)))return corrupt();for(const ref of selected){const cues=eligible.filter(c=>c.albumId===ref.albumId);if(cues.length===1?ref.cueId!==cues[0]!.cueId:ref.cueId!==null)return corrupt();if(ref.cueId===null&&record.checkpoint.items.find(i=>i.albumId===ref.albumId)?.state!=='review')return corrupt();}}
  }
}

export function createLocalCatalogStore(access: Access) {
  function artistMetadataCandidate(db: DatabaseSync, row: Row): ArtistMetadataBackfillCandidate {
    const selected = readTrack(row), located = one(db, 'local_catalog_assets', selected.assetId), asset = readAsset(located);
    const state = readLocalAlbumScanState(db, asset.libraryRootId, String(located.relative), access.conflict);
    sourceProjectionFor(db); const raw = libraryMetadata(db, selected.id).raw;
    return { ordinal: Number(row._artist_ordinal), track: selected, asset, relative: String(located.relative),
      signature: state?.outcome === 'accepted' && state.assetId === asset.id && (state.trackId === selected.id || selected.segment !== null) ? state.signature : null,
      scanJobId: state?.outcome === 'accepted' && state.assetId === asset.id && (state.trackId === selected.id || selected.segment !== null)
        ? String(db.prepare('SELECT job_id FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(asset.libraryRootId, String(located.relative))?.job_id ?? '') || null : null,
      complete: Object.hasOwn(raw, 'artists') && Object.hasOwn(raw, 'albumArtists') };
  }
  // 只复用实际连接的语句；九字段组织投影、根与 Source 授权仍在每次同步读取中重新取得。
  const organizationStatements = new WeakMap<DatabaseSync, Map<string, ReturnType<DatabaseSync['prepare']>>>();
  function organizationStatement(db: DatabaseSync, sql: string) {
    let statements = organizationStatements.get(db);
    if (!statements) { statements = new Map(); organizationStatements.set(db, statements); }
    let statement = statements.get(sql);
    if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
    return statement;
  }
  function organizationBarrier(db: DatabaseSync): string {
    const row = organizationStatement(db, 'SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema').get();
    const values = [row?.changes, row?.version, row?.schema];
    if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || typeof db.isTransaction !== 'boolean') return corrupt();
    return JSON.stringify([...values, db.isTransaction]);
  }
  // 原组织九字段与MB作者水位来自同一实际连接、同一完整SQL屏障；不消费Renderer修订。
  function libraryManagementOrganizationStateForDatabase(db: DatabaseSync, identity: DatasetIdentity) {
    const before = organizationBarrier(db), organizations: LocalAlbumLibraryOrganization[] = [];
    const projection = workbenchProjectionFor(db), bindings = projection.management.get(identity.datasetId)?.records;
    for (const stored of bindings?.values() ?? []) {
      const binding = stored.record;
      if (binding.kind !== 'binding' || !binding.active) continue;
      // 原可见性只由此实际投影中的 active 决定；不重复复制账本或另读同一 binding。
      const row = organizationStatement(db, 'SELECT * FROM local_catalog_roots WHERE id=?').get(binding.libraryId);
      if (!row) return access.conflict('本地对象不存在，请刷新目录。');
      const actual = readRoot(row), source = readSourceRootForDatabase(db, binding.sourceRootId, access.conflict);
      if (binding.datasetId !== identity.datasetId || binding.key !== actual.id || actual.role !== 'library'
        || actual.sourceRootId !== binding.sourceRootId || actual.revision !== binding.rootRevision || !source.authorized)
        throw new CollectionError('INVENTORY_UNAVAILABLE', '原组织角色绑定或来源身份已变化。');
      organizations.push({ datasetId: identity.datasetId, rootId: actual.id, sourceRootId: actual.sourceRootId,
        rootRevision: actual.revision, bindingRevision: binding.revision, recordSha256: stored.recordSha256, role: binding.role,
        rootName: path.basename(source.path), parentName: path.basename(path.dirname(source.path)) });
    }
    organizations.sort((a, b) => a.rootId.localeCompare(b.rootId, 'en'));
    if (organizationBarrier(db) !== before)
      throw new CollectionError('INVENTORY_UNAVAILABLE', '组织投影读取期间 SQL 已变化，请重新读取。');
    return { organizations, originalAuthor: String(projection.mbOnly.get(identity.datasetId)?.highWater ?? 0) };
  }
  function organizedMBOnlyAuthorRevision(state: ReturnType<typeof libraryManagementOrganizationStateForDatabase>): string {
    return state.organizations.length ? createHash('sha256').update(canonical([state.originalAuthor, state.organizations])).digest('hex') : state.originalAuthor;
  }
  function libraryManagementOrganizations(identity: DatasetIdentity): readonly LocalAlbumLibraryOrganization[] {
    assertWorkbenchIdentity(identity);
    const result = access.read(db => libraryManagementOrganizationStateForDatabase(db, identity).organizations);
    assertWorkbenchIdentity(identity); return result;
  }
  const albumReaders = new WeakMap<DatabaseSync, {
    projection: SourceWritesProjection; fingerprint: string; barrier: string
    observationHistory: LocalAlbumSqlObservationHistory | undefined
    inventory: LocalAlbumSqlScope['lyricsInventory']; artworkInventory: LocalAlbumSqlScope['artworkInventory']; readActive: LocalAlbumSqlScope['assertReadActive']; scope: LocalAlbumSqlScope; reader: ReturnType<typeof createLocalAlbumSqlReader>
  }>()
  // 资源库存只变展示修订时，仍由同一实际DB与原Source投影作者提供相同闭包；不能拿新lambda冒充同作者。
  const albumSqlAuthors = new WeakMap<DatabaseSync, {
    projection: SourceWritesProjection; source: Parameters<typeof createLocalAlbumSqlReader>[1]; codec: Parameters<typeof createLocalAlbumSqlReader>[2]
    observationHistory: LocalAlbumSqlObservationHistory | undefined
  }>()
  /** 原guard及Source证明仍逐次执行；只复用同连接、同完整scope和同SQL水位的SELECT作者。 */
  function albumReader(db: DatabaseSync, scope: LocalAlbumSqlScope) {
    const projection = sourceProjectionFor(db), fingerprint = localAlbumSqlScopeFingerprint(scope)
    const observed = localCatalogLibraryObservationSourceForDatabase(db), observationHistory = observed?.observationHistory
    const projectionSql = projection.fullRaw.size === 0 ? unanchoredLibraryProjection : observed?.projectionSql ?? libraryProjection
    const changes = db.prepare('SELECT total_changes() n').get()?.n
    const version = db.prepare('PRAGMA data_version').get()?.data_version
    const schema = db.prepare('PRAGMA schema_version').get()?.schema_version
    if (![changes, version, schema].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return corrupt()
    const barrier = JSON.stringify([changes, version, schema, db.isTransaction]), saved = albumReaders.get(db)
    if (saved && saved.projection === projection && saved.observationHistory === observationHistory && saved.fingerprint === fingerprint && saved.barrier === barrier
      && saved.inventory === scope.lyricsInventory && saved.artworkInventory === scope.artworkInventory && saved.readActive === scope.assertReadActive && isCurrentLocalAlbumSqlReader(db, saved.reader)) return saved.reader
    let author = albumSqlAuthors.get(db)
    if (!author || author.projection !== projection || author.observationHistory !== observationHistory || author.source.projectionSql !== projectionSql) {
      author = { projection, observationHistory, source: { ...(observed ?? {projectionSql:libraryProjection}), projectionSql, sourceLookup: trackId => {
        const value = projection.fullRaw.get(trackId); return value ? { ordinal: value.ledgerOrdinal, fields: value.fields } : undefined
      } }, codec: { track: readTrack, asset: readAsset, versionTokens: libraryVersionTokens, boundedRow,
        scanState: (rootId, relative) => readLocalAlbumScanState(db, rootId, relative, access.conflict),
        scanStateProjected: (rootId, relative, data, count, assetRootId, assetRelative) => readLocalAlbumScanStateProjected(db, rootId, relative, data, count, assetRootId, assetRelative, access.conflict), cue: readLocalAlbumCueSnapshot } }
      albumSqlAuthors.set(db, author)
    }
    const reader = createLocalAlbumSqlReader(db, author.source, author.codec, scope)
    albumReaders.set(db, { projection, observationHistory, fingerprint, barrier, inventory: scope.lyricsInventory, artworkInventory: scope.artworkInventory, readActive: scope.assertReadActive, scope, reader })
    return reader
  }

  let workbenchIdentity:DatasetIdentity|undefined;
  function assertWorkbenchDataset(datasetId:string):void{if(!workbenchIdentity||datasetId!==workbenchIdentity.datasetId)throw new LocalLyricsError('STALE');workbenchIdentity.assertCurrent();}
  function assertWorkbenchIdentity(identity:DatasetIdentity):void{if(identity!==workbenchIdentity)throw new LocalLyricsError('STALE');assertWorkbenchDataset(identity.datasetId);}
  interface LyricsInventoryReadScope {
    datasetId: string; identity: DatasetIdentity; identityAssert: DatasetIdentity['assertCurrent']; db: DatabaseSync
    audit: WorkbenchAudit; revision: number; point: string; transaction: boolean; invalid: boolean; assertActive?: () => void
  }
  let lyricsInventoryReadScope: LyricsInventoryReadScope | undefined
  let artistIndexLyricsReading = false
  const lyricsInventoryChanged = (): never => { if (lyricsInventoryReadScope) lyricsInventoryReadScope.invalid = true; throw new LocalLyricsError('STALE') }
  function checkLyricsInventoryRead(current: LyricsInventoryReadScope, db: DatabaseSync, datasetId: string): void {
    try {
      if (current !== lyricsInventoryReadScope || current.invalid || datasetId !== current.datasetId || workbenchIdentity !== current.identity
        || current.identity.datasetId !== datasetId || current.identity.assertCurrent !== current.identityAssert || db !== current.db
        || db.isTransaction !== current.transaction) return lyricsInventoryChanged()
      // 此回调只由原Domain提供closed/boot/作者与SAB；显式事务和无SAB旧作者不安装快路。
      current.assertActive?.()
      if (current.invalid || workbenchAudits.get(db) !== current.audit || (current.audit.lyrics.get(datasetId)?.highWater ?? 0) !== current.revision) return lyricsInventoryChanged()
    } catch (error) { current.invalid = true; throw error }
  }
  /** 只包原Owner的同步纯库存操作；真实身份、物理点与原歌词作者在首末重新读取。 */
  function withLyricsInventoryRead<T>(datasetId: string, read: () => T, assertActive?: () => void): T {
    if (lyricsInventoryReadScope) return lyricsInventoryChanged()
    assertWorkbenchDataset(datasetId)
    return access.read(db => {
      const audit = workbenchProjectionFor(db), identity = workbenchIdentity!, transaction = db.isTransaction
      const current: LyricsInventoryReadScope = { datasetId, identity, identityAssert: identity.assertCurrent, db, audit,
        revision: audit.lyrics.get(datasetId)?.highWater ?? 0, point: organizationBarrier(db), transaction, invalid: false,
        ...(!transaction && assertActive ? { assertActive } : {}) }
      lyricsInventoryReadScope = current
      try {
        checkLyricsInventoryRead(current, db, datasetId)
        const result = read()
        if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') return lyricsInventoryChanged()
        checkLyricsInventoryRead(current, db, datasetId)
        assertWorkbenchDataset(datasetId)
        checkLyricsInventoryRead(current, db, datasetId)
        // 最后一次可调用外部guard的步骤已完成；后面只做真实只读SQL，不先发布任何回调结果。
        if (workbenchProjectionFor(db) !== audit || organizationBarrier(db) !== current.point) return lyricsInventoryChanged()
        return result
      } finally { lyricsInventoryReadScope = undefined }
    })
  }
  const mbOrigins=new WeakMap<object,{planId:string;hash:string;context:string;origin:'Human'|'AI'|'Provider';remote?:dto.LocalArtworkRemoteSource}>(),mbOriginPlans=new Map<string,{brand:object;origin:'Human'|'AI'|'Provider'}>();

  const one = (db: DatabaseSync, table: Table, id: string): Row => {
    const key = table === 'local_catalog_overrides' ? 'track_id' : 'id';
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id);
    return row ?? access.conflict('本地对象不存在，请刷新目录。');
  };
  const root = (db: DatabaseSync, id: string) => readRoot(one(db, 'local_catalog_roots', id));
  const asset = (db: DatabaseSync, id: string) => readAsset(one(db, 'local_catalog_assets', id));
  const track = (db: DatabaseSync, id: string) => readTrack(one(db, 'local_catalog_tracks', id));
  const authorized = (id: string): RootCapability => { const capability = access.sources.root(id); return capability.authorized ? capability : access.conflict('源目录授权已撤销，现有目录身份仍保留。'); };
  const currentRoot = (db: DatabaseSync, id: string, revision: string): dto.LibraryRoot => {
    assertLibraryManagementRootAvailable(db,id);const value = root(db, id); if (value.revision !== revision) return access.conflict('本地目录关联修订已改变。'); authorized(value.sourceRootId); return value;
  };
  function overlap(db: DatabaseSync, source: RootCapability, except?: string, registering=false, relinking=false): void {
    const activeRelink=relinking&&except!==undefined&&libraryManagementRootActiveForRelink(db,root(db,except));
    for (const row of db.prepare('SELECT * FROM local_catalog_roots').all()) {
      const value = readRoot(row); if (value.id === except) continue;
      if((registering||activeRelink)&&source.id!==value.sourceRootId&&libraryManagementRootRetiredForRegistration(db,value))continue;
      const other = access.sources.root(value.sourceRootId);
      const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
      if (inside(source.path, other.path) || inside(other.path, source.path) || source.dev === other.dev && source.ino === other.ino) access.conflict('本地目录引用重叠，请显式重关联现有目录。');
    }
  }
  function mutationAudit(db: DatabaseSync, operation: dto.LocalCatalogOperation, request: Row) {
    const table = resultTable(operation), identity = operation === 'relink-root' ? request.rootId
      : operation === 'move-asset' || operation === 'replace-asset' ? request.assetId
        : operation === 'select-asset' || operation === 'override-metadata' ? request.trackId
          : operation === 'remove-edition-track' ? request.id : undefined;
    const before = identity === undefined ? undefined : db.prepare(`SELECT * FROM ${table} WHERE ${table === 'local_catalog_overrides' ? 'track_id' : 'id'}=?`).get(String(identity));
    const history = new Map<string, dto.LocalCatalogResult>(), locations = new Map<string, { relative: unknown; sha256: unknown }>(), observations = new Map<string, string>();
    if (before) {
      boundedRow(before);
      const previous = parse(before.data, (v): v is dto.LocalCatalogResult => dto.isLocalCatalogResult(operation, v));
      history.set(`${table}:${String(identity)}`, previous);
      if (operation === 'replace-asset') locations.set(String(identity), { relative: before.relative, sha256: before.sha256 });
    }
    const add = <T extends dto.LocalCatalogResult>(name: Table, id: unknown, read: (row: Row) => T): T => {
      const row = one(db, name, String(id)); boundedRow(row); const value = read(row);
      history.set(`${name}:${String(id)}`, value); return value;
    };
    if (operation === 'register-asset' || operation === 'replace-asset') add('local_catalog_roots', request.libraryRootId, readRoot);
    if (operation === 'move-asset' && before) add('local_catalog_roots', readAsset(before).libraryRootId, readRoot);
    if (operation === 'create-track' || operation === 'select-asset') add('local_catalog_assets', request.assetId, readAsset);
    if (operation === 'link-edition-track') {
      add('local_catalog_editions', request.editionId, row => parse(row.data, dto.isAlbumEdition)); add('local_catalog_tracks', request.trackId, readTrack);
    }
    if (operation === 'observe-metadata' || operation === 'override-metadata') {
      add('local_catalog_tracks', request.trackId, readTrack);
      if (operation === 'observe-metadata') {
        const previous = db.prepare('SELECT * FROM local_catalog_observations WHERE track_id=? ORDER BY rowid DESC LIMIT 1').get(String(request.trackId));
        if (previous) { boundedRow(previous); observations.set(String(request.trackId), parse(previous.data, dto.isLocalMetadataObservation).revision); }
      }
    }
    return { table, before, history, locations, observations };
  }
  function verifyReceipt(row: Row, operation: dto.LocalCatalogOperation, request: Command, result?: dto.LocalCatalogResult): dto.LocalCatalogResult {
    boundedRow(row);
    const body = parse(row.request, (v): v is Row & { commandId: string } => validRequest(operation, v));
    const stored = parse(row.result, (v): v is dto.LocalCatalogResult => dto.isLocalCatalogResult(operation, v));
    if (row.command_id !== request.commandId || row.operation !== operation || row.fingerprint !== fingerprint(operation, request)
      || !same(body, request) || result !== undefined && !same(stored, result)
      || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return corrupt();
    return stored;
  }
  function verifyMutation(db: DatabaseSync, operation: dto.LocalCatalogOperation, request: Row, result: dto.LocalCatalogResult, audit: ReturnType<typeof mutationAudit>): Row {
    const id = 'id' in result ? result.id : result.trackId, row = one(db, audit.table, id); boundedRow(row);
    verifyHistoryStep(db, operation, request, result, audit.history, audit.locations, audit.observations);
    if (!same(JSON.parse(String(row.data)), result)) return corrupt();
    switch (audit.table) {
      case 'local_catalog_roots': readRoot(row); break;
      case 'local_catalog_assets': {
        readAsset(row);
        if (row.relative !== request.relative || (operation === 'move-asset' ? row.sha256 !== audit.before?.sha256 : row.sha256 !== request.sha256)) return corrupt();
        break;
      }
      case 'local_catalog_tracks': { const selected = readTrack(row); checkSegment(selected, asset(db, selected.assetId)); break; }
      case 'local_catalog_editions': { const selected = parse(row.data, dto.isAlbumEdition); if (row.id !== selected.id) return corrupt(); break; }
      case 'local_catalog_edition_tracks': {
        const selected = parse(row.data, dto.isAlbumEditionTrack); if (row.id !== selected.id || row.edition_id !== selected.editionId || row.track_id !== selected.trackId) return corrupt(); break;
      }
      case 'local_catalog_observations': {
        const selected = parse(row.data, dto.isLocalMetadataObservation); if (row.id !== selected.id || row.track_id !== selected.trackId) return corrupt(); break;
      }
      case 'local_catalog_overrides': {
        const selected = parse(row.data, dto.isLocalMetadataOverride); if (row.track_id !== selected.trackId) return corrupt(); break;
      }
      case 'local_catalog_ledger': return corrupt();
    }
    return row;
  }
  /** 私有mutator只核相关对象并写实体+原完整子账本；事务与audit发布由调用者掌握。 */
  function mutate<T extends dto.LocalCatalogResult>(db: DatabaseSync, certificate: AuditCertificate,
    operation: dto.LocalCatalogOperation, request: Command, apply: (db: DatabaseSync) => T): { result: T; certificate: AuditCertificate; changed: boolean; beforeChanges: number } {
    if (!validRequest(operation, request)) return access.conflict('本地目录请求无效。');
    const digest = fingerprint(operation, request), previous = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(request.commandId);
    if (previous) {
      if (previous.fingerprint !== digest || previous.operation !== operation) return access.conflict('同一操作编号不能用于不同本地目录请求。');
      return { result: verifyReceipt(previous, operation, request) as T, certificate, changed: false, beforeChanges: Number(db.prepare('SELECT total_changes() n').get()?.n) };
    }
    const beforeChanges = Number(db.prepare('SELECT total_changes() n').get()?.n), audit = mutationAudit(db, operation, request);
    const result = apply(db); if (!dto.isLocalCatalogResult(operation, result)) return corrupt();
    db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(request.commandId, digest, operation, JSON.stringify(request), JSON.stringify(result), new Date().toISOString());
    const entity = verifyMutation(db, operation, request, result, audit), receipt = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(request.commandId)!;
    verifyReceipt(receipt, operation, request, result);
    const counts = new Map(certificate.rows), entityCount = counts.get(audit.table)! + (audit.before ? 0 : 1), ledgerCount = counts.get('local_catalog_ledger')! + 1;
    checkBudget(`${audit.table}行数`, entityCount, rowBudgets[audit.table]); checkBudget('local_catalog_ledger行数', ledgerCount, rowBudgets.local_catalog_ledger);
    counts.set(audit.table, entityCount); counts.set('local_catalog_ledger', ledgerCount);
    const bytes = certificate.bytes + rowBytes(entity) - (audit.before ? rowBytes(audit.before) : 0) + rowBytes(receipt);
    checkBudget('目录总文本字节', bytes, maxCatalogTextBytes);
    if (Number(db.prepare('SELECT total_changes() n').get()?.n) !== beforeChanges + 2) return corrupt();
    return { result, certificate: { rows: counts, bytes, dataVersion: certificate.dataVersion }, changed: true, beforeChanges };
  }
  function certificateFor(db: DatabaseSync): AuditCertificate {
    const certificate = audits.get(db);
    if (!certificate || dataVersion(db) !== certificate.dataVersion || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
      throw new Error('工作库完整核验凭证或写入约束已改变，请关闭并重新冷开核验；现有数据保留。');
    }
    return certificate;
  }
  function legacyProjectionFor(db:DatabaseSync):LegacyLinksProjection {
    certificateFor(db);const audited=legacyAudits.get(db);if(!audited)return legacyLinksFail('RECOVERY_REQUIRED');if(typeof audited==='string')return legacyLinksFail(audited);
    const rows=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE rowid>? ORDER BY rowid LIMIT 513').all(audited.highWater);
    if(rows.length>512)return legacyLinksFail('BUDGET_EXCEEDED');if(!rows.length)return audited;
    const next=copyLegacyLinksProjection(audited);
    for(const row of rows){boundedRow(row);const n=Number(row._ledger_rowid);if(!Number.isSafeInteger(n)||n<=next.highWater)return corrupt();if(row.operation===LOCAL_LEGACY_LINKS_OPERATION)projectLegacyLinksEvent(next,readLegacyLinksEvent(row));next.highWater=n;}
    legacyAudits.set(db,next);return next;
  }
  function sourceProjectionFor(db:DatabaseSync):SourceWritesProjection{
    certificateFor(db);const saved=sourceWritesAudits.get(db);if(!saved)return sourceWritesFail('RECOVERY_REQUIRED');
    // 同一作者的同步读取固定本次账本水位，只物化本域事件，不额外消费普通元数据的201行预算。
    const highWater=Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n);
    if(!Number.isSafeInteger(highWater)||highWater<saved.highWater)return corrupt();if(highWater===saved.highWater)return saved;
    const rows=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE rowid>? AND rowid<=? AND operation=? ORDER BY rowid LIMIT 513').all(saved.highWater,highWater,SOURCE_WRITES_OPERATION);if(rows.length>512)return sourceWritesFail('BUDGET_EXCEEDED');
    if(!rows.length){
      // 原已核段没有Source事件：仅通用账本水位前进，原fullRaw事实及其实际SELECT作者不变。
      const next={...saved,highWater},author=albumSqlAuthors.get(db);
      if(author?.projection===saved)author.projection=next;
      sourceWritesAudits.set(db,next);return next;
    }
    const next=copySourceWritesProjection(saved);for(const row of rows){boundedRow(row);const ordinal=Number(row._ledger_rowid);projectSourceWritesEvent(next,readSourceWritesEvent(row),ordinal);}next.highWater=highWater;sourceWritesAudits.set(db,next);return next;
  }
  function sourceView(db:DatabaseSync,projection:SourceWritesProjection):SourceWritesReadView{return {projection,receipt:(commandId,fp)=>{const row=db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(commandId);if(!row)return null;boundedRow(row);if(row.operation!==SOURCE_WRITES_OPERATION||row.fingerprint!==fp)return sourceWritesFail('COMMAND_ID_REUSED');return readSourceWritesEvent(row);}};}
  function relocationProjectionFor(db: DatabaseSync): RelocationProjection {
    certificateFor(db);
    const saved = relocationAudits.get(db); if (!saved) return relocationFail('RECOVERY_REQUIRED');
    const highWater = Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n);
    if (!Number.isSafeInteger(highWater) || highWater < saved.highWater) return corrupt();
    if (highWater === saved.highWater) return saved;
    const rows = db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE rowid>? AND rowid<=? AND operation=? ORDER BY rowid LIMIT 32769').all(saved.highWater, highWater, LOCAL_RELOCATION_OPERATION);
    if (rows.length > dto.LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerPlan) return relocationFail('OVER_BUDGET');
    const projection = copyRelocationProjection(saved);
    for (const row of rows) { boundedRow(row); projectRelocationEvent(projection, readRelocationEvent(row), Number(row._ledger_rowid)); }
    projection.highWater = highWater; relocationAudits.set(db, projection); return projection;
  }
  function relocationView(db: DatabaseSync, projection: RelocationProjection): RelocationReadView {
    return { projection, receipt: (commandId, digest) => {
      const row = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(commandId);
      if (!row) return null;
      boundedRow(row);
      if (row.operation !== LOCAL_RELOCATION_OPERATION || row.fingerprint !== digest) return relocationFail('REVISION_CONFLICT');
      const event = readRelocationEvent(row); return event.kind === 'receipt' ? event : relocationFail('RECOVERY_REQUIRED');
    } };
  }
  function legacyView(db:DatabaseSync,p:LegacyLinksProjection):LegacyLinksView {
    return {events:p.events,links:p.links,previews:p.previews,history:p.history,consumed:p.consumed,snapshotFingerprint:p.snapshotFingerprint,slot:(datasetId,key)=>structuredClone(legacyLinksSlot(p,datasetId,key)),receipt:(commandId,fp)=>{
      const row=db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(commandId);if(!row)return null;boundedRow(row);
      if(row.operation!==LOCAL_LEGACY_LINKS_OPERATION||row.fingerprint!==fp)return legacyLinksFail('COMMAND_ID_REUSED');return readLegacyLinksEvent(row);
    }};
  }
  function transaction<T extends dto.LocalCatalogResult>(operation: dto.LocalCatalogOperation, request: Command, apply: (db: DatabaseSync) => T): T {
    if (!validRequest(operation, request)) return access.conflict('本地目录请求无效。');
    return access.read(db => {
      db.exec('BEGIN IMMEDIATE');
      let rollbackWorkbench:WorkbenchAudit|undefined;
      try {
        const previousWorkbench=operation==='relink-root'&&workbenchIdentity?workbenchProjectionFor(db):undefined;
        rollbackWorkbench=previousWorkbench;
        const beforeRelinkRoot=previousWorkbench?root(db,String(request.rootId)):undefined;
        const candidate = mutate(db, certificateFor(db), operation, request, apply);
        if (candidate.changed) {
          access.beforeCommit?.(`local-catalog:${operation}`);
          if (Number(db.prepare('SELECT total_changes() n').get()?.n) !== candidate.beforeChanges + 2) return corrupt();
        }
        if(candidate.changed&&previousWorkbench){
          // Root事实与绑定帧共用原事务；失败时不发布未提交投影或新审计计数。
          const prepared=copyWorkbenchAudit(previousWorkbench),row=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE command_id=?').get(request.commandId)!;
          projectWorkbenchRow(prepared,row,beforeRelinkRoot);
          const rows=libraryRootRelinkBindingRows(db,prepared,String(request.rootId));
          if(rows){appendWorkbenchRows(db,prepared,rows,'local-library-management:root-relink',undefined,candidate.certificate);return candidate.result;}
        }
        access.beforeLocalFactsCommit?.();
        commitLocalFacts(db,access.onLocalFactsFatal); audits.set(db, candidate.certificate); return candidate.result;
      } catch (error) { if(rollbackWorkbench&&db.isTransaction)workbenchAudits.set(db,rollbackWorkbench);rollbackLocalFacts(db,error,access.onLocalFactsFatal); }
    });
  }
  const id = (value: string): void => { if (!dto.isCollectionId(value)) access.conflict('本地对象身份无效。'); };
  const checkTrackSegment = (value: dto.LocalTrack, selected: dto.AudioAsset): void => { try { checkSegment(value, selected); } catch { access.conflict('片段时间基或范围与所选资产不一致。'); } };
  function relocationMember(db: DatabaseSync, row: Row): { asset: dto.AudioAsset; libraryRoot: dto.LibraryRoot; relative: string; catalogSha256: string | null; tracks: dto.LocalTrack[] } {
    boundedRow(row); const selected = readAsset(row);
    if (!relativePath(row.relative) || !sha(row.sha256)) return corrupt();
    const rows = db.prepare('SELECT * FROM local_catalog_tracks WHERE asset_id=? ORDER BY rowid LIMIT 201').all(selected.id);
    if (rows.length > maxCatalogReadRows) throw new LocalCatalogBudgetError('移动共享曲目完整集合', rows.length, maxCatalogReadRows);
    const tracks = rows.map(readTrack);
    for (const value of tracks) checkTrackSegment(value, selected);
    return { asset: { ...selected }, libraryRoot: root(db, selected.libraryRootId), relative: row.relative,
      catalogSha256: row.sha256 as string | null, tracks };
  }
  function applyRegisterRoot(db: DatabaseSync, request: RegisterLibraryRoot): dto.LibraryRoot {
        const source = authorized(request.sourceRootId); overlap(db, source,undefined,request.role==='library');
        const result: dto.LibraryRoot = { id: randomUUID(), sourceRootId: source.id, role: request.role, revision: '1' };
        db.prepare('INSERT INTO local_catalog_roots VALUES(?,?,?)').run(result.id, source.id, JSON.stringify(result)); return result;
  }
  function applyRelinkRoot(db: DatabaseSync, request: RelinkLibraryRoot): dto.LibraryRoot {
        const old = root(db, request.rootId); if (old.revision !== request.expectedRevision) return access.conflict('本地目录关联修订已改变。');
        if(!libraryManagementRootAvailable(db,old.id))return access.conflict('原库已移除或正在移除，不能以重关联绕过目录重叠。');
        if(workbenchIdentity){const binding=workbenchProjectionFor(db).management.get(workbenchIdentity.datasetId)?.records.get('binding:'+old.id)?.record;
          if(binding?.kind==='binding'&&binding.active&&(binding.sourceRootId!==old.sourceRootId||binding.rootRevision!==old.revision))return access.conflict('原重关联绑定尚未结算，请沿原成功回执恢复。');}
        const source = authorized(request.sourceRootId); overlap(db, source, old.id, false, request.role===old.role);
        const result = { ...old, sourceRootId: source.id, role: request.role, revision: next(old.revision) };
        db.prepare('UPDATE local_catalog_roots SET source_root_id=?,data=? WHERE id=?').run(source.id, JSON.stringify(result), old.id); return result;
  }
  function applyRegisterAsset(db: DatabaseSync, request: RegisterAudioAsset): dto.AudioAsset {
        const selected = currentRoot(db, request.libraryRootId, request.expectedRootRevision);
        const result: dto.AudioAsset = { id: randomUUID(), libraryRootId: selected.id, sourceRootId: selected.sourceRootId, rootRevision: selected.revision, fileRevision: '1', locationRevision: '1', sampleFrames: request.sampleFrames, timebaseHz: request.timebaseHz };
        db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(result.id, selected.id, selected.sourceRootId, request.relative, request.sha256, JSON.stringify(result)); return result;
  }
  function applyMoveAsset(db: DatabaseSync, request: MoveAudioAsset): dto.AudioAsset {
        const old = asset(db, request.assetId), selected = currentRoot(db, old.libraryRootId, request.expectedRootRevision);
        if (old.locationRevision !== request.expectedLocationRevision || old.sourceRootId !== selected.sourceRootId) return access.conflict('位置或根关联已改变，需要新的资产观察。');
        const result = { ...old, rootRevision: selected.revision, locationRevision: next(old.locationRevision) };
        db.prepare('UPDATE local_catalog_assets SET relative=?,data=? WHERE id=?').run(request.relative, JSON.stringify(result), old.id); return result;
  }
  function applyReplaceAsset(db: DatabaseSync, request: ReplaceAudioAsset): dto.AudioAsset {
        const old = asset(db, request.assetId), selected = currentRoot(db, request.libraryRootId, request.expectedRootRevision);
        if (old.fileRevision !== request.expectedFileRevision || old.locationRevision !== request.expectedLocationRevision || old.libraryRootId !== selected.id) return access.conflict('资产修订或逻辑目录已改变。');
        const oldLocation = one(db, 'local_catalog_assets', old.id);
        const moved = oldLocation.relative !== request.relative || old.sourceRootId !== selected.sourceRootId;
        const result = { ...old, sourceRootId: selected.sourceRootId, rootRevision: selected.revision, fileRevision: next(old.fileRevision), locationRevision: moved ? next(old.locationRevision) : old.locationRevision, sampleFrames: request.sampleFrames, timebaseHz: request.timebaseHz };
        for (const row of db.prepare('SELECT * FROM local_catalog_tracks WHERE asset_id=?').iterate(old.id)) checkTrackSegment(readTrack(row), result);
        db.prepare('UPDATE local_catalog_assets SET source_root_id=?,relative=?,sha256=?,data=? WHERE id=?').run(selected.sourceRootId, request.relative, request.sha256, JSON.stringify(result), old.id); return result;
  }
  function applyCreateTrack(db: DatabaseSync, request: CreateLocalTrack): dto.LocalTrack {
    assertLibraryManagementRootAvailable(db,asset(db,request.assetId).libraryRootId);
        const selected = asset(db, request.assetId);
        const result: dto.LocalTrack = { id: randomUUID(), assetId: selected.id, selectionRevision: '1', segment: request.segment === null ? null : { ...request.segment, id: randomUUID() } };
        checkTrackSegment(result, selected); db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(result.id, result.assetId, JSON.stringify(result)); return result;
  }
  function applySelectAsset(db: DatabaseSync, request: SelectLocalAsset): dto.LocalTrack {
        const old = track(db, request.trackId); if (old.selectionRevision !== request.expectedSelectionRevision) return access.conflict('曲目选择修订已改变。');
        const selected = asset(db, request.assetId), result = { ...old, assetId: selected.id, selectionRevision: next(old.selectionRevision) };
        checkTrackSegment(result, selected); db.prepare('UPDATE local_catalog_tracks SET asset_id=?,data=? WHERE id=?').run(selected.id, JSON.stringify(result), old.id); return result;
  }
  function applyCreateEdition(db: DatabaseSync, request: CreateAlbumEdition): dto.AlbumEdition {const result: dto.AlbumEdition = { id: randomUUID(), title: request.title, edition: request.edition, revision: '1' }; db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(result.id, JSON.stringify(result)); return result;
  }
  function applyLinkEditionTrack(db: DatabaseSync, request: LinkEditionTrack): dto.AlbumEditionTrack {
        one(db, 'local_catalog_editions', request.editionId); track(db, request.trackId);
        if (db.prepare("SELECT 1 FROM local_catalog_edition_tracks WHERE edition_id=? AND json_extract(data,'$.sequence')=? AND json_extract(data,'$.active')=1").get(request.editionId, request.sequence)) return access.conflict('发行版序号已存在。');
        const result: dto.AlbumEditionTrack = { id: randomUUID(), editionId: request.editionId, trackId: request.trackId, disc: request.disc, trackNumber: request.trackNumber, sequence: request.sequence, revision: '1', active: true };
        db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(result.id, result.editionId, result.trackId, JSON.stringify(result)); return result;
  }
  function applyRemoveEditionTrack(db: DatabaseSync, request: RemoveEditionTrack): dto.AlbumEditionTrack {
        const old = parse(one(db, 'local_catalog_edition_tracks', request.id).data, dto.isAlbumEditionTrack);
        if (old.revision !== request.expectedRevision || !old.active) return access.conflict('发行版关系修订已改变。');
        const result = { ...old, revision: next(old.revision), active: false }; db.prepare('UPDATE local_catalog_edition_tracks SET data=? WHERE id=?').run(JSON.stringify(result), old.id); return result;
  }
  function applyObserveMetadata(db: DatabaseSync, request: ObserveLocalMetadata): dto.LocalMetadataObservation {
        track(db, request.trackId);
        const previous = db.prepare('SELECT data FROM local_catalog_observations WHERE track_id=? ORDER BY rowid DESC LIMIT 1').get(request.trackId);
        const result: dto.LocalMetadataObservation = { id: randomUUID(), trackId: request.trackId, revision: previous ? next(parse(previous.data, dto.isLocalMetadataObservation).revision) : '1', source: request.source, parserVersion: request.parserVersion, fields: { ...request.fields } };
        db.prepare('INSERT INTO local_catalog_observations VALUES(?,?,?)').run(result.id, result.trackId, JSON.stringify(result)); return result;
  }
  function applyOverrideMetadata(db: DatabaseSync, request: OverrideLocalMetadata): dto.LocalMetadataOverride {
        track(db, request.trackId); const previous = db.prepare('SELECT data FROM local_catalog_overrides WHERE track_id=?').get(request.trackId);
        const old = previous ? parse(previous.data, dto.isLocalMetadataOverride) : null;
        if ((old?.revision ?? null) !== request.expectedRevision) return access.conflict('人工元数据修订已改变。');
        const annotations = request.annotations ?? old?.annotations;
        const result: dto.LocalMetadataOverride = { trackId: request.trackId, revision: old ? next(old.revision) : '1', fields: { ...request.fields }, ...(annotations === undefined ? {} : { annotations: structuredClone(annotations) }) };
        db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?) ON CONFLICT(track_id) DO UPDATE SET data=excluded.data').run(result.trackId, JSON.stringify(result)); return result;
  }

  function copyWorkbenchAudit(before:WorkbenchAudit):WorkbenchAudit{
    return {highWater:before.highWater,rootRelinks:new Map(before.rootRelinks),workbench:new Map([...before.workbench].map(([id,p])=>[id,{...p,pending:null}])),
      lyrics:new Map([...before.lyrics].map(([id,p])=>[id,{...p,latest:new Map(p.latest),inventory:new Map(p.inventory),jobOrigins:new Map(p.jobOrigins),pending:null}])),
      cue:new Map([...before.cue].map(([id,p])=>[id,copyLocalCueOwnerProjection(p)])),scanSettings:new Map([...before.scanSettings].map(([id,p])=>[id,copyLocalScanSettingsOwnerProjection(p)])),mbOnly:new Map([...before.mbOnly].map(([id,p])=>[id,copyLocalWorkbenchMBOnlyProjection(p)])),lyricsPhysical:new Map([...before.lyricsPhysical].map(([id,p])=>[id,copyLocalLyricsPhysicalProjection(p)])),management:new Map([...before.management].map(([id,p])=>[id,copyLocalLibraryManagementProjection(p)])),lyricsRoot:new Map([...before.lyricsRoot].map(([id,p])=>[id,copyLocalLyricsRootProjection(p)]))}
  }
  function projectWorkbenchRow(a:WorkbenchAudit,row:Row,beforeRelinkRoot?:dto.LibraryRoot):void{
    boundedRow(row);const ordinal=Number(row._ledger_rowid)
    if(row.operation===LOCAL_LYRICS_ROOT_OPERATION){const e=readLocalLyricsRootEvent(row),p=a.lyricsRoot.get(e.datasetId)??emptyLocalLyricsRootProjection(e.datasetId);projectLocalLyricsRootEvent(p,e,ordinal);a.lyricsRoot.set(e.datasetId,p)}
    else if(row.operation===LOCAL_LIBRARY_MANAGEMENT_OPERATION){const e=readLocalLibraryManagementEvent(row),p=a.management.get(e.datasetId)??emptyLocalLibraryManagementProjection(e.datasetId);projectLocalLibraryManagementEvent(p,e,ordinal);a.management.set(e.datasetId,p)}
    else if(row.operation===LOCAL_WORKBENCH_JOURNAL_OPERATION){const e=readLocalWorkbenchJournalEvent(row),p=a.workbench.get(e.datasetId)??emptyLocalWorkbenchJournalProjection(e.datasetId);projectLocalWorkbenchJournalEvent(p,e,ordinal);a.workbench.set(e.datasetId,p)}
    else if(row.operation===LOCAL_LYRICS_JOURNAL_OPERATION){const e=readLocalLyricsJournalEvent(row),p=a.lyrics.get(e.datasetId)??emptyLocalLyricsJournalProjection(e.datasetId);projectLocalLyricsJournalEvent(p,e,ordinal);a.lyrics.set(e.datasetId,p)}
    else if(row.operation===LOCAL_LYRICS_PHYSICAL_OPERATION){const e=readLocalLyricsPhysicalEvent(row),p=a.lyricsPhysical.get(e.datasetId)??emptyLocalLyricsPhysicalProjection(e.datasetId);projectLocalLyricsPhysicalEvent(p,e,ordinal);a.lyricsPhysical.set(e.datasetId,p)}
    else if(row.operation===LOCAL_CUE_OUTPUT_OPERATION){const e=readLocalCueOwnerEvent(row),p=a.cue.get(e.datasetId)??emptyLocalCueOwnerProjection(e.datasetId);projectLocalCueOwnerEvent(p,e,ordinal);a.cue.set(e.datasetId,p)}
    else if(row.operation===LOCAL_SCAN_SETTINGS_OPERATION){const e=readLocalScanSettingsOwnerEvent(row),p=a.scanSettings.get(e.datasetId)??emptyLocalScanSettingsOwnerProjection(e.datasetId);projectLocalScanSettingsOwnerEvent(p,e,ordinal);a.scanSettings.set(e.datasetId,p)}
    else if(row.operation===LOCAL_WORKBENCH_MB_ONLY_OPERATION){const e=readLocalWorkbenchMBOnlyEvent(row),p=a.mbOnly.get(e.datasetId)??emptyLocalWorkbenchMBOnlyProjection(e.datasetId);projectLocalWorkbenchMBOnlyEvent(p,e,ordinal);a.mbOnly.set(e.datasetId,p)}
    else if(['relink-root','move-asset','replace-asset','select-asset'].includes(String(row.operation))){
      if(row.operation==='relink-root'){const receipt=readRootRelinkReceipt(row,beforeRelinkRoot);a.rootRelinks.set(receipt.request.rootId,receipt)}
      for(const p of a.lyrics.values()){p.inventory.clear();p.highWater=ordinal}}
    else return corrupt()
  }
  function workbenchProjectionFor(db:DatabaseSync):WorkbenchAudit{
    certificateFor(db);const previous=workbenchAudits.get(db);if(!previous)return corrupt()
    const highWater=Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n)
    if(!Number.isSafeInteger(highWater)||highWater<previous.highWater)return corrupt()
    if(highWater===previous.highWater)return previous
    const candidate=copyWorkbenchAudit(previous)
    // 正常同Ownerappend会同步发布cache；此路径仍审本域完整增量，不丢截断尾部。
    for(const row of db.prepare("SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE rowid>? AND rowid<=? AND operation IN (?,?,?,?,?,?,?,?,'relink-root','move-asset','replace-asset','select-asset') ORDER BY rowid").iterate(previous.highWater,highWater,LOCAL_WORKBENCH_JOURNAL_OPERATION,LOCAL_LYRICS_JOURNAL_OPERATION,LOCAL_CUE_OUTPUT_OPERATION,LOCAL_SCAN_SETTINGS_OPERATION,LOCAL_WORKBENCH_MB_ONLY_OPERATION,LOCAL_LYRICS_PHYSICAL_OPERATION,LOCAL_LIBRARY_MANAGEMENT_OPERATION,LOCAL_LYRICS_ROOT_OPERATION))projectWorkbenchRow(candidate,row)
    for(const p of candidate.workbench.values())assertLocalWorkbenchJournalComplete(p)
    for(const p of candidate.lyrics.values())assertLocalLyricsJournalComplete(p)
    for(const p of candidate.cue.values())assertLocalCueOwnerComplete(p)
    for(const p of candidate.mbOnly.values())assertLocalWorkbenchMBOnlyComplete(p)
    for(const p of candidate.lyricsPhysical.values())assertLocalLyricsPhysicalComplete(p)
    for(const p of candidate.management.values())assertLocalLibraryManagementComplete(p)
    for(const p of candidate.lyricsRoot.values())assertLocalLyricsRootComplete(p)
    candidate.highWater=highWater;workbenchAudits.set(db,candidate);return candidate
  }
  function appendWorkbenchRows(db:DatabaseSync,previous:WorkbenchAudit,rows:readonly Record<string,string>[],action:string,captureWrite?:LocalAlbumCaptureWrite,rootRelinkCertificate?:AuditCertificate):void{
    const originalCertificate=certificateFor(db),certificate=rootRelinkCertificate??originalCertificate,candidate=copyWorkbenchAudit(previous),before=Number(db.prepare('SELECT total_changes() n').get()!.n)
    const counts=new Map(certificate.rows);let bytes=certificate.bytes
    for(const row of rows){
      if(Object.values(row).reduce((n,s)=>n+Buffer.byteLength(s),0)>maxRowTextBytes||db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!))throw new LocalLyricsError('CONFLICT')
      db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!,row.fingerprint!,row.operation!,row.request!,row.result!,row.created_at!)
      const saved=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!)!;projectWorkbenchRow(candidate,saved)
      bytes+=rowBytes(saved);const count=counts.get('local_catalog_ledger')!+1;checkBudget('local_catalog_ledger行数',count,rowBudgets.local_catalog_ledger);counts.set('local_catalog_ledger',count);checkBudget('目录总文本字节',bytes,maxCatalogTextBytes)
    }
    for(const p of candidate.workbench.values())assertLocalWorkbenchJournalComplete(p)
    for(const p of candidate.lyrics.values())assertLocalLyricsJournalComplete(p)
    for(const p of candidate.cue.values())assertLocalCueOwnerComplete(p)
    for(const p of candidate.mbOnly.values())assertLocalWorkbenchMBOnlyComplete(p)
    for(const p of candidate.lyricsPhysical.values())assertLocalLyricsPhysicalComplete(p)
    for(const p of candidate.management.values())assertLocalLibraryManagementComplete(p)
    for(const p of candidate.lyricsRoot.values())assertLocalLyricsRootComplete(p)
    if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+rows.length)return corrupt()
    access.beforeCommit?.(action)
    if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+rows.length)return corrupt()
    workbenchIdentity!.assertCurrent();access.beforeLocalFactsCommit?.();captureWrite?.approve(rows);commitLocalFacts(db,access.onLocalFactsFatal)
    candidate.highWater=Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n)
    audits.set(db,{rows:counts,bytes,dataVersion:certificate.dataVersion});workbenchAudits.set(db,candidate)
    captureWrite?.publish()
  }
  function cueOutputRead(identity:DatasetIdentity,commandId:string):{record:LocalCueOutputRecord;ledgerSequence:string}|null{
    assertWorkbenchIdentity(identity);if(!dto.isCollectionId(commandId))throw new LocalLyricsError('INVALID')
    const result=access.read(db=>{const p=workbenchProjectionFor(db).cue.get(identity.datasetId);const value=p?.output.latest.get(commandId);return value?structuredClone(value):null});assertWorkbenchIdentity(identity);return result
  }
  /** 全组原成员CAS；同命令已经完成的嵌入只能沿同SQL真实publication延续。 */
  function assertLyricsPhysicalGroup(db:DatabaseSync,a:WorkbenchAudit,r:LocalLyricsPhysicalRecord):Map<string,dto.AudioAsset>{
    sourceProjectionFor(db);const assets=new Map<string,dto.AudioAsset>();
    for(const m of r.original.members){const t=track(db,m.trackId),current=assets.get(m.fileId)??asset(db,m.fileId),selected=root(db,m.rootId),location=one(db,'local_catalog_assets',m.fileId),resource=r.original.resources[m.resourceIndex]!,own=lyricsPhysicalOwnAsset(r,a,m.fileId,m.fileRevision);
      if(t.assetId!==m.fileId||selected.id!==r.binding.libraryId||selected.revision!==m.rootRevision||selected.sourceRootId!==m.sourceRootId||!authorized(m.sourceRootId)
        ||current.libraryRootId!==m.rootId||current.sourceRootId!==m.sourceRootId||current.rootRevision!==m.rootRevision||current.fileRevision!==own.revision||current.locationRevision!==m.locationRevision
        ||location.relative!==resource.relative||location.sha256!==null&&location.sha256!==(own.sha256??resource.sha256)
        ||lyricsDigest(lyricsCanonical(libraryMetadata(db,m.trackId)))!==m.metadataRevision)throw new LocalLyricsError('STALE');
      if(!assets.has(m.fileId)){const original=r.original.members.filter(v=>v.fileId===m.fileId),rows=db.prepare('SELECT * FROM local_catalog_tracks WHERE asset_id=? ORDER BY rowid LIMIT 10001').all(m.fileId);
        if(rows.length!==original.length||rows.some(row=>!original.some(v=>v.trackId===readTrack(row).id)))throw new LocalLyricsError('STALE');assets.set(m.fileId,current);
      }
    }
    return assets;
  }

  function libraryManagementRead<K extends LocalLibraryManagementRecordKind>(identity:DatasetIdentity,kind:K,key:string):LocalLibraryManagementStored<LocalLibraryManagementRecordMap[K]>|null {
    assertWorkbenchIdentity(identity);if(!['binding','operation','capture','job'].includes(kind)||!dto.isLocalWorkbenchIdentity(key))return corrupt();
    const result=access.read(db=>{const stored=workbenchProjectionFor(db).management.get(identity.datasetId)?.records.get(kind+':'+key);return stored?structuredClone(stored) as LocalLibraryManagementStored<LocalLibraryManagementRecordMap[K]>:null;});assertWorkbenchIdentity(identity);return result;
  }
  /** 同实际连接每次复核完整certificate/projection；头部不泄漏全组的可变别名。 */
  function libraryManagementReadCaptureHeader(identity:DatasetIdentity,key:string):LocalLibraryManagementFrozenAlbumSelection['captureRecord']|null {
    assertWorkbenchIdentity(identity);if(!dto.isLocalWorkbenchIdentity(key))return corrupt()
    const result=access.read(db=>{
      const stored=workbenchProjectionFor(db).management.get(identity.datasetId)?.records.get('capture:'+key)
      if(!stored)return null
      const record=stored.record
      if(record.kind!=='capture'||record.datasetId!==identity.datasetId||record.key!==key)return corrupt()
      const header:LocalLibraryManagementFrozenAlbumSelection['captureRecord']={
        schema:record.schema,kind:record.kind,datasetId:record.datasetId,key:record.key,revision:record.revision,
        originalSha256:record.originalSha256,original:{mode:record.original.mode,watermark:record.original.watermark},
      }
      return structuredClone(header)
    })
    assertWorkbenchIdentity(identity);return result
  }
  function libraryManagementReadFrozenAlbum(identity:DatasetIdentity,scope:dto.LocalLyricsScope):LocalLibraryManagementFrozenAlbumSelection|null {
    assertWorkbenchIdentity(identity)
    if(!dto.isLocalLyricsScope(scope)||scope.datasetId!==identity.datasetId)return corrupt()
    const result=access.read(db=>{
      // 保留原完整projection/certificate与全部record的已核SHA；只复制其中一项，不接当前分页。
      const stored=workbenchProjectionFor(db).management.get(identity.datasetId)?.records.get('capture:'+scope.captureId)
      if(!stored)return null
      const record=stored.record
      if(record.kind!=='capture'||record.datasetId!==identity.datasetId||record.key!==scope.captureId)return corrupt()
      const pin=record.original.libraries.find(value=>value.libraryId===scope.libraryId)
      const album=record.original.albums.find(value=>value.libraryId===scope.libraryId&&value.resolved.capture.albumId===scope.albumId)
      const ref=record.original.albumRefs.find(value=>value.rootId===scope.libraryId&&value.albumId===scope.albumId)
      if(!pin||!album||!ref)return null
      if(album.sourceRootId!==pin.sourceRootId||album.rootRevision!==pin.rootRevision||album.resolved.datasetId!==identity.datasetId
        ||album.resolved.capture.rootId!==scope.libraryId||album.resolved.group.summary.id!==ref.albumId
        ||album.resolved.group.summary.rootId!==ref.rootId||album.resolved.group.summary.revision!==ref.revision)return corrupt()
      const value:LocalLibraryManagementFrozenAlbumSelection={
        captureRecord:{schema:record.schema,kind:record.kind,datasetId:record.datasetId,key:record.key,revision:record.revision,
          originalSha256:record.originalSha256,original:{mode:record.original.mode,watermark:record.original.watermark}},
        managementCapture:{key:record.key,ledgerSequence:stored.ledgerSequence,recordSha256:stored.recordSha256,
          originalSha256:record.originalSha256,...pin},album,
      }
      return structuredClone(value)
    })
    assertWorkbenchIdentity(identity);return result
  }
  function libraryManagementRootAvailable(db:DatabaseSync,libraryId:string):boolean {
    if(!workbenchIdentity)return true;
    assertWorkbenchIdentity(workbenchIdentity);const projection=workbenchProjectionFor(db).management.get(workbenchIdentity.datasetId);
    return libraryManagementRootAvailableInProjection(projection,libraryId);
  }
  function libraryManagementRootAvailableInProjection(projection:LocalLibraryManagementProjection|undefined,libraryId:string):boolean {
    const binding=projection?.records.get('binding:'+libraryId)?.record;
    if(binding?.kind==='binding'&&!binding.active)return false;
    // running/UNKNOWN的原remove也封住新CREATE；关闭失败不允许从空内存Map复活。
    for(const value of projection?.records.values()??[]){const record=value.record;
      if(record.kind==='operation'&&record.original.command==='library.remove'
        &&!['failed','cancelled'].includes(record.receipt.state)&&record.original.request.libraryIds.includes(libraryId))return false;}
    return true;
  }
  /** 旧绑定只消费同根、下一修订且仍是当前Root的原成功事实，不补造一次新操作。 */
  function libraryRootRelinkBindingRows(db:DatabaseSync,a:WorkbenchAudit,libraryId:string):readonly Record<string,string>[]|null {
    if(!workbenchIdentity)return null;
    assertWorkbenchIdentity(workbenchIdentity);const projection=a.management.get(workbenchIdentity.datasetId),stored=projection?.records.get('binding:'+libraryId);
    if(stored?.record.kind!=='binding'||!stored.record.active||!libraryManagementRootAvailableInProjection(projection,libraryId))return null;
    const binding=stored.record,actual=root(db,libraryId),receipt=a.rootRelinks.get(libraryId);
    if(actual.role!=='library'||binding.sourceRootId===actual.sourceRootId&&binding.rootRevision===actual.revision)return null;
    if(!receipt||receipt.request.rootId!==libraryId||receipt.request.expectedRevision!==binding.rootRevision
      ||receipt.request.role!=='library'||!same(receipt.result,actual)||actual.revision!==next(binding.rootRevision))return null;
    const proof:LocalLibraryManagementRootRelinkProof={commandId:receipt.commandId,ledgerSequence:receipt.ledgerSequence,requestFingerprint:receipt.requestFingerprint,
      previousBindingSha256:stored.recordSha256,beforeRoot:{id:libraryId,sourceRootId:binding.sourceRootId,role:'library',revision:binding.rootRevision},afterRoot:actual};
    if(!same(receipt.beforeRoot,proof.beforeRoot))return null;
    verifyLibraryManagementRootRelinkReceipt(db,proof);authorized(actual.sourceRootId);
    return createLocalLibraryManagementRootRelinkEvents(binding,proof).map(localLibraryManagementLedgerRow);
  }
  function recoverLibraryRootRelinkBindings(identity:DatasetIdentity):number {
    assertWorkbenchIdentity(identity);
    const libraries=access.read(db=>[...(workbenchProjectionFor(db).management.get(identity.datasetId)?.records.values()??[])]
      .filter(stored=>stored.record.kind==='binding'&&stored.record.active).map(stored=>stored.record.key));
    let recovered=0;
    for(const libraryId of libraries){assertWorkbenchIdentity(identity);recovered+=access.read(db=>{
      db.exec('BEGIN IMMEDIATE');let rollbackWorkbench:WorkbenchAudit|undefined;try{
        const projection=workbenchProjectionFor(db),rows=libraryRootRelinkBindingRows(db,projection,libraryId);
        rollbackWorkbench=projection;
        if(!rows){db.exec('ROLLBACK');return 0;}
        appendWorkbenchRows(db,projection,rows,'local-library-management:root-relink-recovery');return 1;
      }catch(error){if(rollbackWorkbench&&db.isTransaction)workbenchAudits.set(db,rollbackWorkbench);rollbackLocalFacts(db,error,access.onLocalFactsFatal);}
    });}
    assertWorkbenchIdentity(identity);return recovered;
  }
  /** 登记及合格活动根重关联只忽略完整移除的历史对手；不复活旧根或放宽源搬迁。 */
  function libraryManagementRootRetiredForRegistration(db:DatabaseSync,actual:dto.LibraryRoot):boolean {
    if(!workbenchIdentity)return false;
    assertWorkbenchIdentity(workbenchIdentity);
    if(actual.role!=='library')return false;
    const datasetId=workbenchIdentity.datasetId,projection=workbenchProjectionFor(db).management.get(datasetId),binding=projection?.records.get('binding:'+actual.id)?.record;
    if(binding?.kind!=='binding'||binding.datasetId!==datasetId||binding.key!==actual.id||binding.libraryId!==actual.id||binding.active||binding.watchEnabled
      ||binding.sourceRootId!==actual.sourceRootId||binding.rootRevision!==actual.revision)return false;
    const removed=projection?.records.get('operation:'+binding.operationId)?.record;
    return removed?.kind==='operation'&&removed.datasetId===datasetId&&removed.key===binding.operationId&&removed.original.command==='library.remove'
      &&removed.receipt.state==='succeeded'&&removed.receipt.libraryIds.includes(actual.id)&&removed.original.request.libraryIds.includes(actual.id);
  }
  /** 只决定历史对手能否让路；未绑定、移除未决、身份不吻合或精确资产都没有例外。 */
  function libraryManagementRootActiveForRelink(db:DatabaseSync,actual:dto.LibraryRoot):boolean {
    if(!workbenchIdentity||actual.role!=='library'||!libraryManagementRootAvailable(db,actual.id))return false;
    const datasetId=workbenchIdentity.datasetId,binding=workbenchProjectionFor(db).management.get(datasetId)?.records.get('binding:'+actual.id)?.record;
    return binding?.kind==='binding'&&binding.datasetId===datasetId&&binding.key===actual.id&&binding.libraryId===actual.id&&binding.active
      &&binding.sourceRootId===actual.sourceRootId&&binding.rootRevision===actual.revision
      &&!db.prepare("SELECT id FROM local_catalog_assets WHERE root_id=? AND (sha256 IS NOT NULL OR json_extract(data,'$.sampleFrames') IS NOT NULL OR json_extract(data,'$.timebaseHz') IS NOT NULL) LIMIT 1").get(actual.id);
  }
  function assertLibraryManagementRootAvailable(db:DatabaseSync,libraryId:string):void {
    if(!libraryManagementRootAvailable(db,libraryId))return access.conflict('原库正在撤销或已撤销，仅保留原回执；不能新建扫描、捕获或媒体记录。');
  }
  function libraryManagementReader(db:DatabaseSync,capture:LocalLibraryManagementCaptureRecord,currentOnly=false){
    assertWorkbenchDataset(capture.datasetId);
    const source=sourceProjectionFor(db),audit=workbenchProjectionFor(db),roles=libraryManagementRolesAt(capture,audit),roots:captureRoots=[],libraryOrganizations:LocalAlbumLibraryOrganization[]=[];
    for(const pin of capture.original.libraries){const actual=currentRoot(db,pin.libraryId,pin.rootRevision);if(actual.role!=='library'||actual.sourceRootId!==pin.sourceRootId)return corrupt();const resource=authorized(pin.sourceRootId);
      const availability=capture.original.albums.find(a=>a.libraryId===pin.libraryId)?.resolved.availability;roots.push({root:actual,label:resource.label,availability:availability==='offline'?'SOURCE_ROOT_OFFLINE':availability==='unavailable'?'REVOKED':'ONLINE'});
      const stored=audit.management.get(capture.datasetId)?.records.get('binding:'+pin.libraryId);
      if(stored?.record.kind==='binding'){const binding=stored.record;libraryOrganizations.push({datasetId:capture.datasetId,rootId:actual.id,sourceRootId:actual.sourceRootId,rootRevision:actual.revision,
        bindingRevision:binding.revision,recordSha256:stored.recordSha256,role:binding.role,rootName:path.basename(resource.path),parentName:path.basename(path.dirname(resource.path))});}}
    if(currentOnly){
      const saved=albumReaders.get(db),selectedRoots=new Set(capture.original.libraries.map(pin=>pin.libraryId));
      // 结构化角色只沿当序真实绑定取得资格；后面的完整组织九字段、名称、根和SQL屏障仍须全部相同。
      const rolesCurrent=[...roles].every(([rootId,role])=>role==='catalog'
        ||(role==='album'||role==='artist')&&libraryOrganizations.some(value=>value.rootId===rootId&&value.datasetId===capture.datasetId&&value.role===role));
      // 只借刚完成的真实Owner SELECT作者；Root/组织仍按原管理投影逐项实核，不从capture生成新scope。
      if(db.isTransaction||capture.original.mode!=='albums'||!saved||saved.projection!==source||saved.barrier!==organizationBarrier(db)
        ||saved.fingerprint!==localAlbumSqlScopeFingerprint(saved.scope)||!isCurrentLocalAlbumSqlReader(db,saved.reader)
        ||capture.original.albums.some(album=>album.resolved.group.summary.editionId!==null||album.resolved.group.directory===null)
        ||!rolesCurrent
        ||roots.some(expected=>!saved.scope.roots.some(current=>same(current,expected)))
        ||!same((saved.scope.libraryOrganizations??[]).filter(item=>selectedRoots.has(item.rootId)),libraryOrganizations)
        ||(saved.scope.nameEnhancements??[]).some(item=>selectedRoots.has(item.rootId)))return null;
      return {reader:saved.reader,roles,current:true};
    }
    const reader=createLocalAlbumSqlReader(db,{projectionSql:libraryProjection,sourceLookup:trackId=>{const value=source.fullRaw.get(trackId);return value?{ordinal:value.ledgerOrdinal,fields:value.fields}:undefined;}},
      {track:readTrack,asset:readAsset,versionTokens:libraryVersionTokens,boundedRow,scanState:(rootId,relative)=>readLocalAlbumScanState(db,rootId,relative,access.conflict),
        scanStateProjected:(rootId,relative,data,count,assetRootId,assetRelative)=>readLocalAlbumScanStateProjected(db,rootId,relative,data,count,assetRootId,assetRelative,access.conflict),cue:readLocalAlbumCueSnapshot},{revision:capture.original.watermark,roots,...(libraryOrganizations.length?{libraryOrganizations}: {})});
    return {reader,roles,current:false};
  }
  type captureRoots=dto.LocalRootView[];
  function assertLibraryCaptureCurrent(db:DatabaseSync,value:LocalLibraryManagementCaptureRecord,requireWatermark=true,currentOnly=false):boolean {
    const checkWatermark=()=>{if(requireWatermark&&(value.original.catalogRevision!==albumCatalogRevision(db)||value.original.scanRevision!==albumScanRevision(db)))return access.conflict('完整库捕获的原水位已改变，不能换成当前分页或选择。');};
    if(!currentOnly)checkWatermark();
    const selected=libraryManagementReader(db,value,currentOnly);if(!selected)return false;
    if(currentOnly)checkWatermark();
    const {reader,roles}=selected;
    if(value.original.mode==='library')for(const pin of value.original.libraries){const page=reader.queryAlbums({rootId:pin.libraryId,query:'',filter:'all',offset:0,limit:1});if(page.total!==value.original.albumRefs.filter(ref=>ref.rootId===pin.libraryId).length)return access.conflict('完整库捕获遗漏专辑或仅保存了分页。');}
    for(const captured of value.original.albums){const r=captured.resolved,g=r.group,first=reader.queryAlbumMembers({albumKey:g.summary.id,rootId:g.summary.rootId,offset:0,limit:1});
      if(first.total!==g.members.length)return access.conflict('专辑捕获遗漏完整成员。');
      const role=roles.get(captured.libraryId),organized= g.summary.editionId===null&&(role==='artist'||role==='album'),actualMembers=new Set<string>();
      if(organized){
        // 原同SQL SELECT完整核实际分组成员；分页只是读取传输，不拆业务capture/commit。
        for(let offset=0;offset<first.total;){const page=reader.queryAlbumMembers({albumKey:g.summary.id,rootId:g.summary.rootId,offset,limit:200});
          if(page.total!==first.total||page.album.id!==g.summary.id||page.album.rootId!==captured.libraryId||!page.items.length||page.items.length>first.total-offset)return access.conflict('原组织专辑完整成员读取已改变。');
          for(const member of page.items){const id=member.fact.summary.track.id;if(actualMembers.has(id))return access.conflict('原组织专辑成员身份重复。');actualMembers.add(id);}
          offset+=page.items.length;
        }
        if(actualMembers.size!==g.members.length)return access.conflict('专辑捕获遗漏完整成员。');
      }
      for(const member of g.members){const current=track(db,member.fact.summary.track.id),located=one(db,'local_catalog_assets',member.fact.summary.asset.id),view=libraryMetadata(db,current.id),m=r.capture.members.find(m=>m.trackId===current.id)!;
        if(!same(current,member.fact.summary.track)||!same(readAsset(located),member.fact.summary.asset)||located.relative!==member.fact.relative||!same(view.raw,member.fact.rawMetadata)||!same(view.effective,member.fact.summary.metadata)||localLibraryManagementDigest(view)!==m.metadataRevision)return access.conflict('专辑原根、定位或元数据捕获已改变。');
        const links=db.prepare("SELECT data FROM local_catalog_edition_tracks WHERE track_id=? AND json_extract(data,'$.active')=1 ORDER BY rowid").all(current.id).map(row=>parse(row.data,dto.isAlbumEditionTrack));
        if(organized){if(!actualMembers.has(current.id))return access.conflict('曲目不属于原完整专辑。');}
        else {
        const keys=(links.length?links.map(l=>l.editionId):[null]).map(editionId=>libraryManagementGroupKey(captured.libraryId,editionId,String(located.relative),view.raw));
        if(!keys.includes(g.summary.id))return access.conflict('曲目不属于原完整专辑。');
        }
      }
      const issues=reader.queryAlbumIssues({albumKey:g.summary.id,rootId:g.summary.rootId,offset:0,limit:1},selected.current?{buildDerivedIndex:false}:undefined);if(issues.rejectedTotal!==(g.rejectedFiles?.length??0))return access.conflict('专辑捕获遗漏原拒收文件。');
      for(const cue of r.directoryFacts.cues){const row=db.prepare('SELECT data FROM local_cue_sources WHERE id=?').get(cue.id);if(!row||!same(readLocalAlbumCueSnapshot(row.data),cue))return access.conflict('原CUE来源或完整解析事实已改变。');}
      for(const fact of r.directoryFacts.files){const current=readLocalAlbumScanState(db,captured.libraryId,fact.currentRelative,access.conflict);if(!same(current,fact.value))return access.conflict('原扫描文件事实已改变。');}
    }
    return true;
  }
  function libraryManagementCompareAndSwap(identity:DatasetIdentity,inputs:readonly LocalLibraryManagementWrite[]):{ledgerSequence:string;records:readonly LocalLibraryManagementStored[]} {
    assertWorkbenchIdentity(identity);if(!isLocalWorkbenchDenseArray(inputs,101)||!inputs.length)return corrupt();
    const writes=inputs.map(write=>{if(!write||Object.getPrototypeOf(write)!==Object.prototype||Reflect.ownKeys(write).length!==2||!Object.hasOwn(write,'record')||!Object.hasOwn(write,'expectedRevision')||!Object.hasOwn(Object.getOwnPropertyDescriptor(write,'record')!,'value')||!Object.hasOwn(Object.getOwnPropertyDescriptor(write,'expectedRevision')!,'value'))return corrupt();const record=captureLocalLibraryManagementOwnerRecord(write.record);if(record.datasetId!==identity.datasetId||write.expectedRevision!==null&&(!Number.isSafeInteger(write.expectedRevision)||write.expectedRevision<1))return corrupt();return {record,expectedRevision:write.expectedRevision};});
    if(new Set(writes.map(w=>w.record.kind+':'+w.record.key)).size!==writes.length)return corrupt();
    const result=access.read(db=>{
      // 只有本批全为首次完整capture才创建独立证书；不把其它管理写解释为“无关写”。
      const captureWrite=writes.every(write=>write.record.kind==='capture'&&write.expectedRevision===null)?captureLocalAlbumCaptureWrite(db,identity.datasetId):undefined;
      const prepared=new Set<LocalLibraryManagementCaptureRecord>();let preparedPoint:ReturnType<typeof localAlbumScanPoint>=null;
      const samePoint=(left:ReturnType<typeof localAlbumScanPoint>,right:ReturnType<typeof localAlbumScanPoint>)=>left!==null&&right!==null&&left.changes===right.changes&&left.version===right.version&&left.schema===right.schema;
      if(!db.isTransaction&&writes.some(write=>write.record.kind==='capture'&&write.expectedRevision===null)){
        const before=localAlbumScanPoint(db),old=workbenchProjectionFor(db).management.get(identity.datasetId);
        if(before)for(const write of writes)if(write.record.kind==='capture'&&write.expectedRevision===null&&!old?.records.has('capture:'+write.record.key)){
          const started=performance.now();
          if(assertLibraryCaptureCurrent(db,write.record,true,true))prepared.add(write.record);
          logLibraryOperation('library','workbench.capture.verify','complete',{code:prepared.has(write.record)?'CURRENT_OWNER_SCOPE':'ORIGINAL_FALLBACK',elapsedMs:Math.max(0,performance.now()-started)});
        }
        assertWorkbenchIdentity(identity);
        if(samePoint(before,localAlbumScanPoint(db)))preparedPoint=before;else prepared.clear();
      }
      db.exec('BEGIN IMMEDIATE');try{
      const a=workbenchProjectionFor(db),p=a.management.get(identity.datasetId)??emptyLocalLibraryManagementProjection(identity.datasetId),records=writes.map(w=>w.record);
      const exact=writes.every(w=>{const old=p.records.get(w.record.kind+':'+w.record.key);return old&&same(old.record,w.record)&&w.expectedRevision===old.record.revision-1;});
      if(exact){db.exec('ROLLBACK');const saved=writes.map(w=>structuredClone(p.records.get(w.record.kind+':'+w.record.key)!));return {ledgerSequence:saved.at(-1)!.ledgerSequence,records:saved};}
      for(const write of writes){const old=p.records.get(write.record.kind+':'+write.record.key);if((old?.record.revision??null)!==write.expectedRevision)return access.conflict('Library原命令CAS修订已改变。');}
      assertLocalLibraryManagementBatch(p.records,records);
      for(const record of records){
        if(record.kind==='operation')verifyLibraryManagementImportReceipt(db,record);
        if(record.kind==='binding'&&(record.active||record.revision===1)){
          // 初始旧库停用标记已受本批原remove约束；只读核pin，不借新CREATE口绕过running封口。
          const actual=record.active?currentRoot(db,record.libraryId,record.rootRevision):root(db,record.libraryId);
          if(actual.role!=='library'||actual.sourceRootId!==record.sourceRootId||actual.revision!==record.rootRevision)return access.conflict('管理绑定必须来自原实际LibraryRoot，不能以UUID代替来源。');
        }
        if(record.kind==='capture'){
          // 本次同步预核后BEGIN已锁同DB快照；任何未知写/外部提交/schema跳转均不能消费这份局部证明。
          const started=performance.now();let current=false;
          if(prepared.has(record)&&db.isTransaction){
            for(const pin of record.original.libraries){const actual=currentRoot(db,pin.libraryId,pin.rootRevision);if(actual.role!=='library'||actual.sourceRootId!==pin.sourceRootId)return corrupt();authorized(pin.sourceRootId);}
            libraryManagementRolesAt(record,a);
            current=samePoint(preparedPoint,localAlbumScanPoint(db));
          }
          if(!current)assertLibraryCaptureCurrent(db,record);
          logLibraryOperation('library','workbench.capture.verify','complete',{code:current?'LOCKED_POINT_MATCH':'LOCKED_ORIGINAL_CHECK',elapsedMs:Math.max(0,performance.now()-started)});
        }
        if(record.kind==='job'){assertLibraryManagementJobCapture(record,p);assertLibraryManagementJobReceipts(record,a);if(record.revision===1){const captured=p.records.get('capture:'+record.original.captureId)!.record;if(captured.kind!=='capture')return corrupt();assertLibraryCaptureCurrent(db,captured,false);}}
      }
      const retired=records.filter((record):record is LocalLibraryManagementBindingRecord=>record.kind==='binding'&&!record.active);
      if(retired.length){
        const candidates=new Set<string>(),editions=new Set<string>();
        for(const projection of a.workbench.values())for(const entry of projection.snapshot?.entries??[])for(const artwork of entry.capture.artwork??[])candidates.add(artwork.candidateId);
        for(const link of legacyProjectionFor(db).links.values())if(link.state==='active'&&link.endpoints.kind==='legacy-edition')editions.add(link.endpoints.localEditionId);
        for(const binding of retired)pruneLocalLibraryArtworkCacheInTransaction(db,binding.libraryId,{candidates,editions});
      }
      const events=createLocalLibraryManagementBatchEvents(writes.map(w=>({record:w.record,previous:p.records.get(w.record.kind+':'+w.record.key)?.record??null})));
      appendWorkbenchRows(db,a,events.map(localLibraryManagementLedgerRow),'local-library-management:cas',captureWrite);
      const actual=workbenchAudits.get(db)?.management.get(identity.datasetId);if(!actual)return corrupt();
      const saved=writes.map(w=>structuredClone(actual.records.get(w.record.kind+':'+w.record.key)!));return {ledgerSequence:saved.at(-1)!.ledgerSequence,records:saved};
    }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal);}});assertWorkbenchIdentity(identity);return result;
  }
  function lyricsRootRead<K extends LocalLyricsRootRecordKind>(identity:DatasetIdentity,kind:K,key:string):Readonly<LocalLyricsRootRecordMap[K]>|null{
    assertWorkbenchIdentity(identity);if(!['original-capture','save-snapshot'].includes(kind)||(kind==='original-capture'?!sha(key):!dto.isCollectionId(key)))throw new LocalLyricsError('INVALID');
    const result=access.read(db=>{const value=workbenchProjectionFor(db).lyricsRoot.get(identity.datasetId)?.records.get(kind+':'+key);return value?structuredClone(value) as LocalLyricsRootRecordMap[K]:null;});assertWorkbenchIdentity(identity);return result;
  }
  function lyricsRootCompareAndSwap(identity:DatasetIdentity,input:LocalLyricsRootRecord,expectedRevision:number|null):void{
    assertWorkbenchIdentity(identity);const record=captureLocalLyricsRootRecord(input);if(record.datasetId!==identity.datasetId)throw new LocalLyricsError('STALE');
    access.read(db=>{db.exec('BEGIN IMMEDIATE');try{const a=workbenchProjectionFor(db),p=a.lyricsRoot.get(identity.datasetId),old=p?.records.get(record.kind+':'+record.key)??null;
      if((old?.revision??null)!==expectedRevision)throw new LocalLyricsError('CONFLICT');assertLocalLyricsRootTransition(old,record);verifyLyricsRootRecord(db,a,record,true);
      appendWorkbenchRows(db,a,createLocalLyricsRootEvents(record,old).map(localLyricsRootLedgerRow),'local-lyrics-root:cas');
    }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal);}});assertWorkbenchIdentity(identity);
  }
  function lyricsPhysicalPending(identity:DatasetIdentity):readonly LocalLyricsPhysicalStored[]{
    assertWorkbenchIdentity(identity);const result=access.read(db=>{const p=workbenchProjectionFor(db).lyricsPhysical.get(identity.datasetId);if(p)assertLocalLyricsPhysicalComplete(p);
      return structuredClone([...(p?.records.values()??[])].filter(item=>!['CLOSED','FAILED'].includes(item.record.phase)||!item.record.physicalClosed||!item.record.protectionReleased).map(item=>({record:item.record,ledgerSequence:item.ledgerSequence})));});assertWorkbenchIdentity(identity);return result;
  }
  function cueOutputPending(identity:DatasetIdentity):readonly {record:LocalCueOutputRecord;ledgerSequence:string}[]{
    assertWorkbenchIdentity(identity);const result=access.read(db=>{const p=workbenchProjectionFor(db).cue.get(identity.datasetId);if(p)assertLocalCueOwnerComplete(p);
      return structuredClone([...(p?.output.latest.values()??[])].filter(item=>!['succeeded','failed','cancelled'].includes(item.record.phase)||!item.record.physicalClosed));});assertWorkbenchIdentity(identity);return result;
  }
  function lyricsPhysicalPublications(identity:DatasetIdentity,commandId:string):readonly {record:LocalLyricsPhysicalRecord;ledgerSequence:number;publication:LocalLyricsPhysicalPublication|null;publicationSequence:number|null}[]{
    assertWorkbenchIdentity(identity);if(!dto.isLocalWorkbenchIdentity(commandId))return corrupt();
    const result=access.read(db=>{const a=workbenchProjectionFor(db),items=[...(a.lyricsPhysical.get(identity.datasetId)?.records.values()??[])].filter(item=>item.record.binding.commandId===commandId);
      for(const item of items){const index=a.lyrics.get(identity.datasetId)?.latest.get('save:'+commandId);if(!index||index.recordKind!=='save')return corrupt();const saved=readLyricsRecord(db,index) as LocalLyricsSaveRecord;assertLocalLyricsSaveRecord(saved);const b=item.record.binding;if(saved.intent.request.commandId!==commandId||saved.intent.scope.datasetId!==identity.datasetId||b.originalIntentSha256!==lyricsPhysicalDigest(saved.intent)||b.originalRequestSha256!==lyricsPhysicalDigest(saved.intent.request)||b.intentFingerprint!==saved.intent.fingerprint||b.groupCaptureSha256!==saved.intent.captureFingerprint)return corrupt();}
      return structuredClone(items.map(item=>({record:item.record,ledgerSequence:item.ledgerSequence,publication:item.publication,publicationSequence:item.publicationSequence})).sort((x,y)=>x.ledgerSequence-y.ledgerSequence));});assertWorkbenchIdentity(identity);return result;
  }

  function lyricsPhysicalRead(identity:DatasetIdentity,operationId:string):LocalLyricsPhysicalStored|null{
    assertWorkbenchIdentity(identity);if(!/^[a-f0-9]{64}$/u.test(operationId))throw new LocalLyricsError('INVALID');
    const result=access.read(db=>{const value=workbenchProjectionFor(db).lyricsPhysical.get(identity.datasetId)?.records.get(operationId);return value?{record:structuredClone(value.record),ledgerSequence:value.ledgerSequence}:null;});assertWorkbenchIdentity(identity);return result;
  }
  function lyricsPhysicalCompareAndSwap(identity:DatasetIdentity,input:LocalLyricsPhysicalRecord,expectedRevision:number|null):number{
    assertWorkbenchIdentity(identity);const record=captureLocalLyricsPhysicalRecord(input);if(record.binding.datasetId!==identity.datasetId||record.phase==='FACTS_COMMITTED')throw new LocalLyricsError('INVALID');
    const result=access.read(db=>{db.exec('BEGIN IMMEDIATE');try{const a=workbenchProjectionFor(db),previous=a.lyricsPhysical.get(identity.datasetId)?.records.get(record.operationId);
      if((previous?.record.revision??null)!==expectedRevision)throw new LocalLyricsError('CONFLICT');lyricsPhysicalOriginalSave(db,a,record);
      if(!['FAILED','UNKNOWN'].includes(record.phase))assertLyricsPhysicalGroup(db,a,record);
      const events=createLocalLyricsPhysicalEvents(record,previous?.record??null);appendWorkbenchRows(db,a,events.map(localLyricsPhysicalLedgerRow),'local-lyrics-physical:cas');
      const value=workbenchAudits.get(db)?.lyricsPhysical.get(identity.datasetId)?.records.get(record.operationId);if(!value)return corrupt();return value.ledgerSequence;
    }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal);}});assertWorkbenchIdentity(identity);return result;
  }
  function lyricsPhysicalCommitPublication(identity:DatasetIdentity,input:LocalLyricsPhysicalRecord,expectedRevision:number):number{
    assertWorkbenchIdentity(identity);const record=captureLocalLyricsPhysicalRecord(input),b=record.binding;
    if(b.datasetId!==identity.datasetId||record.phase!=='FACTS_COMMITTED'||!record.grant||!record.artifacts.target||record.physicalClosed||record.protectionReleased||record.unresolved
      ||!['saved','existing'].includes(String(record.result?.state))||record.result?.bodySha256!==b.bodySha256)throw new LocalLyricsError('INVALID');
    const result=access.read(db=>{db.exec('BEGIN IMMEDIATE');let committed=false;try{
      const a=workbenchProjectionFor(db),previous=a.lyricsPhysical.get(identity.datasetId)?.records.get(record.operationId);
      if(!previous||previous.record.revision!==expectedRevision||previous.record.phase!=='PUBLISHED'||previous.publication)throw new LocalLyricsError('CONFLICT');
      const saved=lyricsPhysicalOriginalSave(db,a,record),assets=assertLyricsPhysicalGroup(db,a,record),policy=sourceWritesPolicy(sourceProjectionFor(db),identity.datasetId);
      if(!policy.enabled||policy.draining)throw new LocalLyricsError('CLOSED');
      const candidate=copyWorkbenchAudit(a),initialChanges=Number(db.prepare('SELECT total_changes() n').get()!.n),member=record.original.members.find(m=>m.trackId===b.trackId)!;
      const resource=record.original.resources[member.resourceIndex]!,target=record.artifacts.target!;
      if(target.rootId!==resource.rootId||b.kind==='lrc'&&target.sha256!==b.bodySha256)throw new LocalLyricsError('STALE');
      let certificate=certificateFor(db),changed=0,scanPublish:(()=>void)|undefined;
      const append=(rows:readonly Record<string,string>[]):void=>{for(const row of rows){
        if(Object.values(row).reduce((n,s)=>n+Buffer.byteLength(s),0)>maxRowTextBytes||db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!))throw new LocalLyricsError('CONFLICT');
        db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!,row.fingerprint!,row.operation!,row.request!,row.result!,row.created_at!);
        const stored=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!)!;projectWorkbenchRow(candidate,stored);changed++;
        const counts=new Map(certificate.rows),count=counts.get('local_catalog_ledger')!+1,bytes=certificate.bytes+rowBytes(stored);checkBudget('local_catalog_ledger行数',count,rowBudgets.local_catalog_ledger);checkBudget('目录总文本字节',bytes,maxCatalogTextBytes);counts.set('local_catalog_ledger',count);certificate={rows:counts,bytes,dataVersion:certificate.dataVersion};
      }};
      let replace:LocalLyricsPhysicalPublication['replace']=null,scan:LocalLyricsPhysicalPublication['scan']=null;
      if(b.kind==='embed'){
        const before=assets.get(member.fileId)!,fidelity=record.fidelity;if(!fidelity||fidelity.sourceSha256!==resource.sha256||fidelity.copySha256!==target.sha256||target.relative!==resource.relative
          ||before.sampleFrames!==null&&before.sampleFrames!==String(fidelity.frames)||before.timebaseHz!==null&&before.timebaseHz!==fidelity.sampleRate)throw new LocalLyricsError('STALE');
        const locator=one(db,'local_catalog_assets',before.id),scanRow=db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(member.rootId,resource.relative);
        if(!scanRow||typeof scanRow.data!=='string')throw new LocalLyricsError('STALE');
        const scanBefore=JSON.parse(scanRow.data) as Row;if(scanBefore.libraryRootId!==member.rootId||scanBefore.relative!==resource.relative||scanBefore.assetId!==member.fileId||scanBefore.signature!==resource.signature||scanBefore.outcome!=='accepted'||!scanBefore.readFacts)throw new LocalLyricsError('STALE');
        const request:ReplaceAudioAsset={commandId:randomUUID(),assetId:before.id,libraryRootId:member.rootId,expectedRootRevision:member.rootRevision,expectedFileRevision:before.fileRevision,expectedLocationRevision:before.locationRevision,relative:resource.relative,sha256:target.sha256,sampleFrames:before.sampleFrames,timebaseHz:before.timebaseHz};
        const mutation=mutate(db,certificate,'replace-asset',request,d=>applyReplaceAsset(d,request));if(!mutation.changed)return corrupt();certificate=mutation.certificate;changed+=2;
        const child=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE command_id=?').get(request.commandId)!;projectWorkbenchRow(candidate,child);
        const after=mutation.result as dto.AudioAsset;assets.set(before.id,after);replace={commandId:request.commandId,ledgerSequence:Number(child._ledger_rowid),before,after,relative:resource.relative,catalogSha256:locator.sha256 as string|null};
        const scanAfter=JSON.stringify({...scanBefore,signature:target.signature});scan={rootId:member.rootId,relative:resource.relative,jobId:String(scanRow.job_id),batchId:String(scanRow.batch_id),before:scanRow.data,after:scanAfter};
        scanPublish=updateSourceWriteScanFacts(db,scan.rootId,scan.relative,scan.jobId,scan.batchId,scan.before,scan.after);changed++;
      }
      const lyrics=a.lyrics.get(identity.datasetId)!,inventoryKey=lyricsDigest(lyricsCanonical([b.libraryId,b.albumId])),priorInventory=lyrics.latest.get(`inventory:${inventoryKey}`);
      const inventory:LocalLyricsInventoryRecord={scope:saved.intent.scope,captureFingerprint:b.groupCaptureSha256,revision:priorInventory?priorInventory.revision+1:0,
        observations:record.original.members.map(m=>{const asset=assets.get(m.fileId)!,old=lyrics.inventory.get(m.trackId),oldRevision=lyricsPhysicalOwnAsset(record,a,m.fileId,m.fileRevision).revision;
          const fact=old&&old.rootId===m.rootId&&old.fileRevision===oldRevision?old:{lrc:'unknown' as const,embedded:'unknown' as const};
          return {trackId:m.trackId,fileRevision:asset.fileRevision,lrc:m.resourceIndex===member.resourceIndex&&b.kind==='lrc'?'true' as const:fact.lrc,embedded:m.resourceIndex===member.resourceIndex&&b.kind==='embed'?'true' as const:fact.embedded};})};
      append(createLocalLyricsRecordEvents('inventory',inventory,priorInventory?.revision??null).map(localLyricsJournalLedgerRow));
      const inventoryIndex=candidate.lyrics.get(identity.datasetId)?.latest.get(`inventory:${inventoryKey}`);if(!inventoryIndex)return corrupt();
      const publication:LocalLyricsPhysicalPublication={schema:1,datasetId:identity.datasetId,operationId:record.operationId,replace,scan,inventory:{record:inventory,ledgerSequence:inventoryIndex.lastOrdinal}};
      append(createLocalLyricsPhysicalEvents(record,previous.record,publication).map(localLyricsPhysicalLedgerRow));
      const value=candidate.lyricsPhysical.get(identity.datasetId)?.records.get(record.operationId);if(!value)return corrupt();verifyLyricsPhysicalPublication(db,record,publication,candidate,value.ledgerSequence);
      for(const p of candidate.lyricsPhysical.values())assertLocalLyricsPhysicalComplete(p);for(const p of candidate.lyrics.values())assertLocalLyricsJournalComplete(p);
      if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==initialChanges+changed)return corrupt();access.beforeCommit?.('local-lyrics-physical:publication');
      if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==initialChanges+changed)return corrupt();assertWorkbenchIdentity(identity);access.beforeLocalFactsCommit?.();commitLocalFacts(db,access.onLocalFactsFatal);committed=true;
      candidate.highWater=Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n);audits.set(db,certificate);workbenchAudits.set(db,candidate);scanPublish?.();return value.ledgerSequence;
    }catch(error){if(committed){access.onLocalFactsFatal?.();throw new LocalFactsCommitFatal();}rollbackLocalFacts(db,error,access.onLocalFactsFatal);}});assertWorkbenchIdentity(identity);return result;
  }
  function cueOutputCompareAndSwap(identity:DatasetIdentity,record:LocalCueOutputRecord,expectedRevision:number|null):{ledgerSequence:string}{
    assertWorkbenchIdentity(identity);if(!isLocalCueOutputRecord(record)||record.request.datasetId!==identity.datasetId)throw new LocalLyricsError('INVALID')
    const events=createLocalCueOutputEvents(record,expectedRevision)
    const result=access.read(db=>{db.exec('BEGIN IMMEDIATE');try{
      const a=workbenchProjectionFor(db),previous=a.cue.get(identity.datasetId)?.output.latest.get(record.request.commandId)
      if((previous?.record.revision??null)!==expectedRevision)throw new LocalLyricsError('CONFLICT')
      appendWorkbenchRows(db,a,events.map(localCueOwnerLedgerRow),'local-cue-output:cas')
      const value=workbenchAudits.get(db)?.cue.get(identity.datasetId)?.output.latest.get(record.request.commandId);if(!value)return corrupt();return {ledgerSequence:value.ledgerSequence}
    }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal)}});assertWorkbenchIdentity(identity);return result
  }
  function scanSettingsStore(identity:DatasetIdentity):LocalScanSettingsStore{
    assertWorkbenchIdentity(identity)
    const check=(requested:DatasetIdentity):void=>{if(requested!==identity)throw new LocalLyricsError('STALE');assertWorkbenchIdentity(identity)}
    const write=(requested:DatasetIdentity,event:LocalScanSettingsEvent):LocalScanSettings|LocalScanFrozenSettings=>{
      check(requested);if(!isLocalScanSettingsEvent(event)||event.datasetId!==identity.datasetId)throw new LocalLyricsError('INVALID')
      const result=access.read(db=>{db.exec('BEGIN IMMEDIATE');try{
        const a=workbenchProjectionFor(db),current=a.scanSettings.get(identity.datasetId)??emptyLocalScanSettingsOwnerProjection(identity.datasetId),prior=localScanSettingsOwnerOriginal(current,event)
        if(prior){db.exec('ROLLBACK');return prior}
        appendWorkbenchRows(db,a,[localScanSettingsOwnerLedgerRow(event)],'local-scan-settings:'+event.kind)
        const saved=workbenchAudits.get(db)?.scanSettings.get(identity.datasetId)?.commands.get(event.commandId);if(!saved)return corrupt();return structuredClone(saved.result)
      }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal)}});check(requested);return result
    }
    return {
      read(requested){check(requested);const result=access.read(db=>structuredClone((workbenchProjectionFor(db).scanSettings.get(identity.datasetId)??emptyLocalScanSettingsOwnerProjection(identity.datasetId)).settings));check(requested);return result},
      save(requested,event){if(event.kind!=='settings')throw new LocalLyricsError('INVALID');return write(requested,event) as LocalScanSettings},
      frozen(requested,jobId){check(requested);if(!dto.isCollectionId(jobId))throw new LocalLyricsError('INVALID');const result=access.read(db=>{const value=workbenchProjectionFor(db).scanSettings.get(identity.datasetId)?.jobs.get(jobId);return value?structuredClone(value):null});check(requested);return result},
      freeze(requested,event){if(event.kind!=='launch')throw new LocalLyricsError('INVALID');return write(requested,event) as LocalScanFrozenSettings},
    }
  }
  function mbEntry(db:DatabaseSync,identity:DatasetIdentity,planId:string){
    assertWorkbenchIdentity(identity);const a=workbenchProjectionFor(db),entry=a.workbench.get(identity.datasetId)?.snapshot?.entries.find(e=>e.plan.planId===planId)
    if(!entry)throw new LocalLyricsError('STALE');return {a,entry}
  }
  function mbNameSources(db:DatabaseSync,identity:DatasetIdentity,fact:LocalWorkbenchMetadataProvenanceFact):LocalWorkbenchMBNameSources{
    assertWorkbenchIdentity(identity);if(!dto.isCollectionId(fact.trackId))throw new LocalLyricsError('INVALID');const current=db.prepare("SELECT o.data,(SELECT l.command_id FROM local_catalog_ledger l WHERE l.operation='override-metadata' AND json_extract(l.result,'$.trackId')=t.id ORDER BY l.rowid DESC LIMIT 1) command_id FROM local_catalog_tracks t LEFT JOIN local_catalog_overrides o ON o.track_id=t.id WHERE t.id=?").get(fact.trackId);if(!current)throw new LocalLyricsError('STALE');const override=current.data===null?null:parse(current.data,dto.isLocalMetadataOverride);if(!override)return fact.override?{artistName:'unknown',albumName:'unknown'}:{artistName:'raw',albumName:'raw'}
    const unknown:LocalWorkbenchMBNameSources={artistName:Object.hasOwn(override.fields,'artist')?'unknown':'raw',albumName:Object.hasOwn(override.fields,'album')?'unknown':'raw'};if(!fact.override||current.command_id!==fact.override.commandId||override.revision!==fact.override.revision||!same(override.fields,fact.override.fields))return unknown
    const p=workbenchProjectionFor(db).mbOnly.get(identity.datasetId),proof=p?.provenance.get(fact.trackId)
    return proof&&proof.commandId===fact.override.commandId&&proof.revision===fact.override.revision&&same(proof.fields,fact.override.fields)?structuredClone(proof.sources):unknown
  }
  function mbValidate(db:DatabaseSync,identity:DatasetIdentity,plan:dto.LocalWorkbenchPlan,capture:LocalWorkbenchPlanCapture,resolved:readonly Readonly<LocalWorkbenchResolvedReadCapture>[]):void{
    const {a,entry}=mbEntry(db,identity,plan.planId);if(plan.kind==='cue'||!same(entry.plan,plan)||!same(entry.capture,capture)||plan.scope!=='MB_ONLY'||plan.state!=='ready'||Date.parse(plan.expiresAt)<=Date.now())throw new LocalLyricsError('STALE')
    assertLocalWorkbenchCapturedPlan(plan,capture)
    if(resolved.length!==capture.albums.length||capture.albums.reduce((n,b)=>n+b.members.length,0)>10000)throw new LocalCatalogBudgetError('MB整组完整成员',capture.albums.reduce((n,b)=>n+b.members.length,0),10000)
    const organizationState=libraryManagementOrganizationStateForDatabase(db,identity),author=String(a.mbOnly.get(identity.datasetId)?.highWater??0),catalogRevision=albumCatalogRevision(db),scanRevision=albumScanRevision(db)
    if(author!==organizationState.originalAuthor)throw new LocalLyricsError('STALE')
    const authorRevisions=organizationState.organizations.length?[organizedMBOnlyAuthorRevision(organizationState)]:[null,author]
    const revisions=authorRevisions.map(v=>createHash('sha256').update(JSON.stringify([identity.datasetId,catalogRevision,scanRevision,v])).digest('hex'))
    if(!revisions.includes(capture.datasetRevision))throw new LocalLyricsError('STALE')
    if(plan.kind==='ai'&&plan.items.some(item=>item.changes.some(change=>typeof change.after!=='string'||!dto.isLocalCatalogText(change.after,true))))throw new LocalLyricsError('INVALID')
    const seen=new Set<string>()
    for(const [i,album]of capture.albums.entries()){
      const fresh=resolved[i]!;if(fresh.availability!=='online'||fresh.datasetId!==identity.datasetId||fresh.datasetRevision!==capture.datasetRevision||!same(fresh.capture,album)||fresh.group.summary.id!==album.albumId)throw new LocalLyricsError('STALE')
      assertLibraryManagementRootAvailable(db,album.rootId);const r=root(db,album.rootId);authorized(r.sourceRootId)
      const ids=album.members.map(m=>m.trackId);if(ids.some(id=>id===null)||!same([...ids].sort(),fresh.group.members.map(m=>m.fact.summary.track.id).sort()))throw new LocalLyricsError('STALE')
      const byTrack=new Map(fresh.group.members.map(member=>[member.fact.summary.track.id,member])),currentSources:{artistName:LocalWorkbenchNameSource[];albumName:LocalWorkbenchNameSource[]}={artistName:[],albumName:[]}
      for(const member of album.members){
        if(member.trackId===null||member.assetId===null||seen.has(member.trackId))throw new LocalLyricsError('STALE');seen.add(member.trackId)
        const t=track(db,member.trackId),assetRow=one(db,'local_catalog_assets',member.assetId),as=readAsset(assetRow),view=libraryMetadata(db,t.id)
        if(t.assetId!==member.assetId||as.libraryRootId!==album.rootId||as.sourceRootId!==r.sourceRootId||r.revision!==member.rootRevision||as.rootRevision!==member.rootRevision||as.fileRevision!==member.fileRevision||as.locationRevision!==member.locationRevision||path.posix.basename(String(assetRow.relative))!==member.fileName
          ||createHash('sha256').update(canonical(view)).digest('hex')!==member.metadataRevision||view.raw.title!==undefined&&view.raw.title!==member.title||view.raw.artist!==undefined&&view.raw.artist!==member.artist||view.raw.album!==undefined&&view.raw.album!==member.album)throw new LocalLyricsError('STALE')
        const groupMember=byTrack.get(member.trackId);if(!groupMember||!same(groupMember.fact.summary.track,t)||!same(groupMember.fact.summary.asset,as)||groupMember.fact.relative!==assetRow.relative||!same(groupMember.fact.rawMetadata,view.raw)||!same(groupMember.fact.summary.metadata,view.effective))throw new LocalLyricsError('STALE')
        const latest=db.prepare("SELECT command_id FROM local_catalog_ledger WHERE operation='override-metadata' AND json_extract(result,'$.trackId')=? ORDER BY rowid DESC LIMIT 1").get(t.id),fact:LocalWorkbenchMetadataProvenanceFact={trackId:t.id,override:view.override?{commandId:String(latest?.command_id),revision:view.override.revision,fields:view.override.fields}:null},sources=mbNameSources(db,identity,fact);currentSources.artistName.push(sources.artistName);currentSources.albumName.push(sources.albumName)
      }
      for(const field of ['artistName','albumName'] as const){const sources=currentSources[field],actual=sources.includes('manual')?'manual':sources.includes('unknown')?'unknown':sources.includes('workbench-ai')?'workbench-ai':'raw',captured=album.nameSources?.[field]??'unknown';if(actual==='manual'&&(!album.manualLocks[field]||captured!=='manual')||actual==='unknown'&&!['manual','unknown'].includes(captured))throw new LocalLyricsError('STALE');const item=plan.items.find(value=>value.albumId===album.albumId);if(plan.kind==='ai'&&['manual','unknown'].includes(actual)&&item?.changes.some(change=>change.field===(field==='artistName'?'artist':'album')&&change.after!==change.before))throw new LocalLyricsError('STALE')}
      if(album.editionId!==null){const edition=parse(one(db,'local_catalog_editions',album.editionId).data,dto.isAlbumEdition),linked=db.prepare("SELECT data FROM local_catalog_edition_tracks WHERE edition_id=? AND json_extract(data,'$.active')=1 ORDER BY rowid").all(album.editionId).map(v=>parse(v.data,dto.isAlbumEditionTrack));
        const captured=capture.albums.filter(b=>b.editionId===album.editionId).flatMap(b=>b.members.map(m=>m.trackId));if(edition.title!==album.albumName||!same(linked.map(l=>l.trackId).sort(),[...captured].sort()))throw new LocalLyricsError('STALE')}
    }
  }
  function mbOriginRoutes(identity:DatasetIdentity){
    assertWorkbenchIdentity(identity)
    const register=(planId:string,origin:'Human'|'AI'|'Provider',remote?:dto.LocalArtworkRemoteSource):object=>{
      assertWorkbenchIdentity(identity);return access.read(db=>{const {entry}=mbEntry(db,identity,planId);if(entry.original!==null||entry.plan.kind==='cue'||origin!=='Provider'&&entry.plan.kind!=='ai'||origin==='Provider'&&(entry.plan.kind!=='artwork'||!dto.isLocalArtworkRemoteSource(remote)))throw new LocalLyricsError('STALE')
        const prior=mbOriginPlans.get(planId);if(prior){const actual=mbOrigins.get(prior.brand);if(prior.origin!==origin||!actual||!same(actual.remote??null,remote??null))throw new LocalLyricsError('CONFLICT');return prior.brand}
        const brand=Object.freeze({});mbOrigins.set(brand,{planId,hash:entry.plan.planHash,context:entry.plan.contextFingerprint,origin,...(remote?{remote:structuredClone(remote)}:{})});mbOriginPlans.set(planId,{brand,origin});return brand})
    }
    return {registerHumanNamePlan:(planId:string)=>register(planId,'Human'),registerAiPreviewPlan:(planId:string)=>register(planId,'AI'),registerProviderArtworkPlan:(planId:string,remote:dto.LocalArtworkRemoteSource)=>register(planId,'Provider',remote)}
  }
  function mbReadReceipt(identity:DatasetIdentity,request:dto.LocalWorkbenchApplyRequest):dto.LocalWorkbenchReceipt|null{
    assertWorkbenchIdentity(identity);if(!dto.isLocalWorkbenchApplyRequest(request)||request.datasetId!==identity.datasetId)throw new LocalLyricsError('INVALID')
    const result=access.read(db=>{const {a,entry}=mbEntry(db,identity,request.planId);if(!entry.original)return null;if(!same(entry.original,request))throw new LocalLyricsError('CONFLICT');const v=a.mbOnly.get(identity.datasetId)?.latest.get(request.commandId);return v?structuredClone(v.record.receipt):entry.receipt&&['failed','succeeded'].includes(entry.receipt.state)?structuredClone(entry.receipt):null});assertWorkbenchIdentity(identity);return result
  }
  function mbApply(identity:DatasetIdentity,request:dto.LocalWorkbenchApplyRequest,plan:dto.LocalWorkbenchPlan,capture:LocalWorkbenchPlanCapture,resolved:readonly Readonly<LocalWorkbenchResolvedReadCapture>[],origin:object|null):dto.LocalWorkbenchReceipt{
    assertWorkbenchIdentity(identity);if(!dto.isLocalWorkbenchApplyRequest(request)||request.datasetId!==identity.datasetId)throw new LocalLyricsError('INVALID')
    const result=access.read(db=>{db.exec('BEGIN IMMEDIATE');try{
      const before=Number(db.prepare('SELECT total_changes() n').get()!.n),{a,entry}=mbEntry(db,identity,request.planId);if(!same(entry.original,request)||!same(entry.plan,plan)||!same(entry.capture,capture))throw new LocalLyricsError('CONFLICT')
      const prior=a.mbOnly.get(identity.datasetId)?.latest.get(request.commandId);if(prior){db.exec('ROLLBACK');return structuredClone(prior.record.receipt)}
      let certificate=certificateFor(db),changed=0,known:'Human'|'AI'|'Artwork'|'Unknown'=plan.kind==='artwork'?'Artwork':'Unknown';const branded=origin?mbOrigins.get(origin):null
      if(branded&&branded.planId===plan.planId&&branded.hash===plan.planHash&&branded.context===plan.contextFingerprint&&['Human','AI'].includes(branded.origin))known=branded.origin as 'Human'|'AI'
      const record:LocalWorkbenchMBOnlyRecord={schema:1,request:structuredClone(request),plan:structuredClone(plan),capture:structuredClone(capture),origin:known,
        receipt:{commandId:request.commandId,datasetId:request.datasetId,planId:request.planId,planHash:request.planHash,state:'succeeded',items:plan.items.map(i=>({itemId:i.itemId,albumId:i.albumId,label:i.label,state:'applied',message:null})),message:null},mutations:[],editionUpdates:[],artwork:[],provenance:[]}
      const mutations:LocalWorkbenchMBOnlyRecord['mutations'][number][]=[],editions:LocalWorkbenchMBOnlyRecord['editionUpdates'][number][]=[],artworks:LocalWorkbenchMBOnlyRecord['artwork'][number][]=[],provenance:LocalWorkbenchMBOnlyRecord['provenance'][number][]=[]
      try{mbValidate(db,identity,plan,capture,resolved);if(plan.kind==='ai'&&known==='Unknown'||plan.kind==='artwork'&&capture.artwork?.some(v=>v.origin==='provider')&&(!branded||branded.origin!=='Provider'||branded.hash!==plan.planHash||branded.context!==plan.contextFingerprint))throw new LocalLyricsError('STALE')}
      catch{record.origin='Unknown';record.receipt={...record.receipt,state:'failed',message:'原捕获、名称作者或图片许可未确认，整组未应用。',items:record.receipt.items.map(i=>({...i,state:'not-written',message:'完整原组未确认，未写入MB事实。'}))}}
      const apply=(operation:'override-metadata'|'create-edition'|'link-edition-track',body:Command&Row,fn:(db:DatabaseSync)=>dto.LocalCatalogResult)=>{
        const old=Number(db.prepare('SELECT total_changes() n').get()!.n),v=mutate(db,certificate,operation,body,fn);certificate=v.certificate;changed+=Number(db.prepare('SELECT total_changes() n').get()!.n)-old
        const row=db.prepare('SELECT rowid AS sequence FROM local_catalog_ledger WHERE command_id=?').get(body.commandId)!;mutations.push({commandId:body.commandId,operation,sequence:String(row.sequence),request:structuredClone(body),result:structuredClone(v.result)});return v.result}
      if(record.receipt.state==='succeeded')for(const album of capture.albums){
        if(plan.kind==='ai'){
          const item=plan.items.find(i=>i.albumId===album.albumId)!;const updates=Object.fromEntries(item.changes.filter(v=>v.after!==v.before).map(v=>[v.field,v.after])) as dto.LocalMetadata
          for(const member of album.members){const t=member.trackId!,view=libraryMetadata(db,t),oldRow=db.prepare("SELECT command_id FROM local_catalog_ledger WHERE operation='override-metadata' AND json_extract(result,'$.trackId')=? ORDER BY rowid DESC LIMIT 1").get(t)
            const priorFact:LocalWorkbenchMetadataProvenanceFact={trackId:t,override:view.override?{commandId:String(oldRow?.command_id),revision:view.override.revision,fields:view.override.fields}:null},sources=mbNameSources(db,identity,priorFact),fields={...view.override?.fields,...updates}
            if(Object.hasOwn(updates,'artist'))sources.artistName=known==='Human'?'manual':'workbench-ai';if(Object.hasOwn(updates,'album'))sources.albumName=known==='Human'?'manual':'workbench-ai'
            const body:OverrideLocalMetadata={commandId:randomUUID(),trackId:t,expectedRevision:view.override?.revision??null,fields,...(view.override?.annotations?{annotations:structuredClone(view.override.annotations)}:{})},value=apply('override-metadata',body as unknown as Command&Row,d=>applyOverrideMetadata(d,body)) as dto.LocalMetadataOverride
            provenance.push({trackId:t,commandId:body.commandId,revision:value.revision,fields:value.fields,sources})
          }
          if(album.editionId&&Object.hasOwn(updates,'album')){const oldRow=one(db,'local_catalog_editions',album.editionId),old=parse(oldRow.data,dto.isAlbumEdition),nextValue={...old,title:updates.album!,revision:next(old.revision)};if(editions.some(v=>v.before.id===old.id)){if(editions.find(v=>v.before.id===old.id)!.after.title!==nextValue.title)throw new LocalLyricsError('CONFLICT')}else{
            db.prepare('UPDATE local_catalog_editions SET data=? WHERE id=?').run(JSON.stringify(nextValue),old.id);const afterRow=one(db,'local_catalog_editions',old.id);boundedRow(afterRow);if(!same(parse(afterRow.data,dto.isAlbumEdition),nextValue))return corrupt();certificate={...certificate,bytes:certificate.bytes+rowBytes(afterRow)-rowBytes(oldRow)};checkBudget('目录总文本字节',certificate.bytes,maxCatalogTextBytes);changed++;editions.push({before:old,after:nextValue})}}
        }else if(plan.kind==='artwork'){
          let editionId=album.editionId
          if(editionId===null){const body:CreateAlbumEdition={commandId:randomUUID(),title:album.albumName||album.directoryName||'未命名专辑',edition:''},edition=apply('create-edition',body as unknown as Command&Row,d=>applyCreateEdition(d,body)) as dto.AlbumEdition;editionId=edition.id
            const group=resolved.find(value=>value.capture.albumId===album.albumId)!.group,byTrack=new Map(group.members.map(member=>[member.fact.summary.track.id,member]));for(const [i,member]of album.members.entries()){const actual=byTrack.get(member.trackId!)!,body:LinkEditionTrack={commandId:randomUUID(),editionId,trackId:member.trackId!,disc:actual.disc??1,trackNumber:actual.trackNumber??i+1,sequence:i+1};apply('link-edition-track',body as unknown as Command&Row,d=>applyLinkEditionTrack(d,body))}}
          const selected=capture.artwork!.find(v=>v.albumId===album.albumId)!,commandId=randomUUID(),value=applyLocalWorkbenchArtworkInTransaction(db,{commandId,editionId,capture:selected,...(branded?.remote?{remoteSource:branded.remote}:{})});changed+=value.changes;artworks.push({albumId:album.albumId,editionId,commandId,selection:value.selection})
        }
      }
      record.mutations=mutations;record.editionUpdates=editions;record.artwork=artworks;record.provenance=provenance
      const candidate=copyWorkbenchAudit(a),events=createLocalWorkbenchMBOnlyEvents(record),counts=new Map(certificate.rows);let bytes=certificate.bytes
      for(const row of events.map(localWorkbenchMBOnlyLedgerRow)){if(db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!))throw new LocalLyricsError('CONFLICT');db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!,row.fingerprint!,row.operation!,row.request!,row.result!,row.created_at!);const saved=db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!)!;boundedRow(saved);projectWorkbenchRow(candidate,saved);changed++;bytes+=rowBytes(saved);counts.set('local_catalog_ledger',counts.get('local_catalog_ledger')!+1);checkBudget('local_catalog_ledger行数',counts.get('local_catalog_ledger')!,rowBudgets.local_catalog_ledger);checkBudget('目录总文本字节',bytes,maxCatalogTextBytes)}
      for(const p of candidate.mbOnly.values())assertLocalWorkbenchMBOnlyComplete(p);verifyLocalArtworkDatabase(db)
      if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+changed)return corrupt();access.beforeCommit?.('local-workbench-mb-only:apply');if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+changed)return corrupt();assertWorkbenchIdentity(identity);access.beforeLocalFactsCommit?.();commitLocalFacts(db,access.onLocalFactsFatal)
      candidate.highWater=Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n);audits.set(db,{rows:counts,bytes,dataVersion:certificate.dataVersion});workbenchAudits.set(db,candidate);return structuredClone(record.receipt)
    }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal)}});assertWorkbenchIdentity(identity);return result
  }
  const result = {

    /** 只能由当前真实domain身份安装；不是公开DTO/随机UUID生成权限。 */
    privateBindWorkbenchDataset(identity:DatasetIdentity):void{
      if(!dto.isCommandOutboxDatasetId(identity.datasetId))throw new LocalLyricsError('INVALID')
      identity.assertCurrent();if(workbenchIdentity&&workbenchIdentity!==identity)throw new LocalLyricsError('STALE');workbenchIdentity=identity
    },
    privateWorkbenchMBOnlyOriginRoutes:mbOriginRoutes,
    privateWorkbenchMBOnlyRevalidate(identity:DatasetIdentity,plan:dto.LocalWorkbenchPlan,capture:LocalWorkbenchPlanCapture,resolved:readonly Readonly<LocalWorkbenchResolvedReadCapture>[]){assertWorkbenchIdentity(identity);access.read(db=>mbValidate(db,identity,plan,capture,resolved));assertWorkbenchIdentity(identity)},
    privateWorkbenchMBOnlyApply:mbApply,
    privateWorkbenchMBOnlyReadReceipt:mbReadReceipt,
    privateWorkbenchMBOnlyReadNameSources(identity:DatasetIdentity,fact:LocalWorkbenchMetadataProvenanceFact){const result=access.read(db=>mbNameSources(db,identity,fact));assertWorkbenchIdentity(identity);return result},
    privateWorkbenchMBOnlyReadOverrideAuthor(identity:DatasetIdentity,fact:LocalWorkbenchMetadataProvenanceFact):LocalWorkbenchNameSource{const s=access.read(db=>mbNameSources(db,identity,fact));assertWorkbenchIdentity(identity);return Object.values(s).includes('manual')?'manual':Object.values(s).includes('unknown')?'unknown':Object.values(s).includes('workbench-ai')?'workbench-ai':'unknown'},
    privateWorkbenchMBOnlyAuthorRevision(identity:DatasetIdentity){assertWorkbenchIdentity(identity);const result=access.read(db=>organizedMBOnlyAuthorRevision(libraryManagementOrganizationStateForDatabase(db,identity)));assertWorkbenchIdentity(identity);return result},
    privateLibraryManagementRead:libraryManagementRead,
    privateRecoverLibraryRootRelinkBindings:recoverLibraryRootRelinkBindings,
    privateLibraryManagementReadCaptureHeader:libraryManagementReadCaptureHeader,
    privateLibraryManagementReadFrozenAlbum:libraryManagementReadFrozenAlbum,
    privateLibraryManagementRootAvailable(libraryId:string):boolean{id(libraryId);return access.read(db=>libraryManagementRootAvailable(db,libraryId));},
    privateLibraryManagementRootRetiredForRegistration(libraryId:string):boolean{id(libraryId);return access.read(db=>libraryManagementRootRetiredForRegistration(db,root(db,libraryId)));},
    privateLibraryManagementRootActiveForRelink(libraryId:string):boolean{id(libraryId);return access.read(db=>libraryManagementRootActiveForRelink(db,root(db,libraryId)));},
    privateLibraryManagementRootVisible(libraryId:string):boolean{id(libraryId);return access.read(db=>{if(!workbenchIdentity)return true;assertWorkbenchIdentity(workbenchIdentity);const stored=workbenchProjectionFor(db).management.get(workbenchIdentity.datasetId)?.records.get('binding:'+libraryId)?.record;return stored?.kind!=='binding'||stored.active;});},
    privateLibraryManagementJobs(identity:DatasetIdentity):readonly Readonly<LocalLibraryManagementJobRecord>[]{assertWorkbenchIdentity(identity);return access.read(db=>structuredClone([...(workbenchProjectionFor(db).management.get(identity.datasetId)?.records.values()??[])].filter(value=>value.record.kind==='job').map(value=>value.record as LocalLibraryManagementJobRecord)));},
    privateLyricsLibraryRecords(identity:DatasetIdentity,libraryId:string):{jobs:LocalLyricsJobRecord[];saves:LocalLyricsSaveRecord[]}{
      assertWorkbenchIdentity(identity);id(libraryId);return access.read(db=>{const p=workbenchProjectionFor(db).lyrics.get(identity.datasetId),jobs:LocalLyricsJobRecord[]=[],saves:LocalLyricsSaveRecord[]=[];
        for(const index of p?.latest.values()??[]){if(index.recordKind==='job'){const record=readLyricsRecord(db,index) as LocalLyricsJobRecord;if(record.snapshot.library.libraryId===libraryId)jobs.push(record);}
          else if(index.recordKind==='save'&&index.scope?.libraryId===libraryId)saves.push(readLyricsRecord(db,index) as LocalLyricsSaveRecord);}
        assertWorkbenchIdentity(identity);return {jobs,saves};});
    },
    privateLibraryManagementCompareAndSwap:libraryManagementCompareAndSwap,
    privateLibraryManagementOrganizations:libraryManagementOrganizations,
    privateLibraryManagementBindings(identity:DatasetIdentity):readonly LocalLibraryManagementStored<LocalLibraryManagementBindingRecord>[]{assertWorkbenchIdentity(identity);const result=access.read(db=>structuredClone([...(workbenchProjectionFor(db).management.get(identity.datasetId)?.records.values()??[])].filter((item):item is LocalLibraryManagementStored<LocalLibraryManagementBindingRecord>=>item.record.kind==='binding')));assertWorkbenchIdentity(identity);return result;},
    privateLibraryManagementRevision(identity:DatasetIdentity):string{assertWorkbenchIdentity(identity);const value=access.read(db=>String(workbenchProjectionFor(db).management.get(identity.datasetId)?.highWater??0));assertWorkbenchIdentity(identity);return value;},
    privateLyricsRootRead:lyricsRootRead,
    privateLyricsRootCompareAndSwap:lyricsRootCompareAndSwap,
    privateLyricsPhysicalPending:lyricsPhysicalPending,
    privateLyricsPhysicalPublications:lyricsPhysicalPublications,
    privateCueOutputPending:cueOutputPending,
    privateCueOutputRead:cueOutputRead,
    privateCueOutputCompareAndSwap:cueOutputCompareAndSwap,
    privateLyricsPhysicalRead:lyricsPhysicalRead,
    privateLyricsPhysicalAssertOriginal(identity:DatasetIdentity,operationId:string,revision:number):void{
      assertWorkbenchIdentity(identity);access.read(db=>{const a=workbenchProjectionFor(db),record=a.lyricsPhysical.get(identity.datasetId)?.records.get(operationId)?.record;
        if(!record||record.revision!==revision||!['PREPARED','FAILED'].includes(record.phase)||record.unresolved)throw new LocalLyricsError('STALE');
        lyricsPhysicalOriginalSave(db,a,record);assertLyricsPhysicalGroup(db,a,record);
      });assertWorkbenchIdentity(identity);
    },
    privateLyricsPhysicalCompareAndSwap:lyricsPhysicalCompareAndSwap,
    privateLyricsPhysicalCommitPublication:lyricsPhysicalCommitPublication,
    privateScanSettingsStore:scanSettingsStore,
    privateWorkbenchSnapshot(datasetId:string){assertWorkbenchDataset(datasetId);return access.read(db=>{const a=workbenchProjectionFor(db),p=a.workbench.get(datasetId);assertWorkbenchDataset(datasetId);return p?.snapshot?structuredClone(p.snapshot):null})},
    privateWorkbenchCompareAndSwap(datasetId:string,expectedRevision:number,events:readonly LocalWorkbenchJournalEvent[]):void{
      assertWorkbenchDataset(datasetId);access.read(db=>{db.exec('BEGIN IMMEDIATE');try{
        const a=workbenchProjectionFor(db),current=a.workbench.get(datasetId)??emptyLocalWorkbenchJournalProjection(datasetId)
        if(current.revision!==expectedRevision||events.length===0||events.some(e=>e.datasetId!==datasetId||e.expectedRevision!==expectedRevision))throw new LocalLyricsError('CONFLICT')
        appendWorkbenchRows(db,a,events.map(localWorkbenchJournalLedgerRow),'local-workbench:cas')
      }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal)}})
    },
    privateLyricsRecord(datasetId:string,kind:LocalLyricsRecordKind,key:string):LocalLyricsDurableRecord|null{
      assertWorkbenchDataset(datasetId);return access.read(db=>{const p=workbenchProjectionFor(db).lyrics.get(datasetId),index=p?.latest.get(`${kind}:${key}`);const result=index?readLyricsRecord(db,index):null;assertWorkbenchDataset(datasetId);return result})
    },
    privateLyricsJobOrigin(identity:DatasetIdentity,request:dto.LocalLyricsSaveRequest,scope:dto.LocalLyricsScope){
      assertWorkbenchIdentity(identity);if(!dto.isLocalLyricsCommandPayload('localLyrics.save',request)||!dto.isLocalLyricsScope(scope)||scope.datasetId!==identity.datasetId)throw new LocalLyricsError('INVALID');
      const value=access.read(db=>{const entry=workbenchProjectionFor(db).lyrics.get(identity.datasetId)?.jobOrigins.get(request.commandId);
        if(!entry)return null;if(!same(entry.request,request)||!same(entry.scope,scope))throw new LocalLyricsError('STALE');return structuredClone(entry.origin);});assertWorkbenchIdentity(identity);return value;
    },
    privateLyricsPending(datasetId:string,scope:dto.LocalLyricsScope):readonly LocalLyricsSaveRecord[]{
      assertWorkbenchDataset(datasetId);if(!dto.isLocalLyricsScope(scope)||scope.datasetId!==datasetId)throw new LocalLyricsError('INVALID')
      return access.read(db=>{const p=workbenchProjectionFor(db).lyrics.get(datasetId),indexes=p?[...p.latest.values()].filter(i=>i.recordKind==='save'&&i.pending&&i.scope?.datasetId===datasetId&&i.scope.libraryId===scope.libraryId&&i.scope.albumId===scope.albumId):[]
        const result=indexes.map(i=>readLyricsRecord(db,i) as LocalLyricsSaveRecord);assertWorkbenchDataset(datasetId);return result})
    },
    privateLyricsCompareAndSwap(datasetId:string,kind:LocalLyricsRecordKind,value:LocalLyricsDurableRecord,expectedRevision:number|null):void{
      assertWorkbenchDataset(datasetId);const identity=localLyricsRecordIdentity(kind,value);if(identity.datasetId!==datasetId)throw new LocalLyricsError('STALE')
      access.read(db=>{db.exec('BEGIN IMMEDIATE');try{
        const a=workbenchProjectionFor(db),p=a.lyrics.get(datasetId)??emptyLocalLyricsJournalProjection(datasetId),previous=p.latest.get(`${kind}:${identity.key}`)
        if((previous?.revision??null)!==expectedRevision)throw new LocalLyricsError('CONFLICT')
        // 与初始intent同一事务，另实例/新capture不能在同album未决时创建新原id。
        if(kind==='save'&&expectedRevision===null&&[...p.latest.values()].some(i=>i.recordKind==='save'&&i.pending&&i.scope&&identity.scope&&i.scope.datasetId===datasetId&&i.scope.libraryId===identity.scope.libraryId&&i.scope.albumId===identity.scope.albumId))throw new LocalLyricsError('IN_FLIGHT')
        if(kind==='save'&&expectedRevision===null){
          const r=value as LocalLyricsSaveRecord
          for(const selected of r.intent.selected){const t=track(db,selected.track.trackId),assetValue=asset(db,t.assetId),rootValue=root(db,assetValue.libraryRootId)
            if(t.segment!==null||assetValue.libraryRootId!==r.intent.scope.libraryId||rootValue.revision!==selected.track.rootRevision||assetValue.rootRevision!==selected.track.rootRevision
              ||assetValue.fileRevision!==selected.track.fileRevision||assetValue.locationRevision!==selected.track.locationRevision
              ||lyricsDigest(lyricsCanonical(libraryMetadata(db,t.id)))!==selected.track.metadataRevision)throw new LocalLyricsError('STALE')
          }
        }
        const events=kind==='save'&&previous?createLocalLyricsStateEvents(value as LocalLyricsSaveRecord,previous):createLocalLyricsRecordEvents(kind,value,expectedRevision)
        appendWorkbenchRows(db,a,events.map(localLyricsJournalLedgerRow),'local-lyrics:cas')
      }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal)}})
    },
    privateLyricsTrackFacts(datasetId:string,trackId:string,rootId:string,fileRevision:string):{lrc:dto.LocalLyricsPresence;embedded:dto.LocalLyricsPresence}{
      assertWorkbenchDataset(datasetId);return access.read(db=>{const audited=workbenchProjectionFor(db),fact=audited.lyrics.get(datasetId)?.inventory.get(trackId);return fact&&fact.rootId===rootId&&fact.fileRevision===fileRevision?{lrc:fact.lrc,embedded:fact.embedded}:{lrc:'unknown',embedded:'unknown'}})
    },
    privateLyricsInventoryRevision(datasetId:string):string{assertWorkbenchDataset(datasetId);return access.read(db=>String(workbenchProjectionFor(db).lyrics.get(datasetId)?.highWater??0))},
    /** 仅独立只读索引作业使用已审计账本；不绑定或伪造 Domain 身份，不授予 Source/写权限。 */
    privateWithArtistIndexLyricsRead<T>(datasetId: string, expectedRevision: string, assertActive: () => void, read: (view: LocalAlbumLyricsInventory) => T): T {
      const changed = (): never => { throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '艺人索引歌词快照已变化或同步作用域已结束。') }
      if (artistIndexLyricsReading || !dto.isCommandOutboxDatasetId(datasetId) || typeof expectedRevision !== 'string') return changed()
      return access.read(db => {
        if (!db.isTransaction || db.prepare('PRAGMA query_only').get()?.query_only !== 1
          || db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0) return changed()
        assertActive()
        const audit = workbenchProjectionFor(db), revision = String(audit.lyrics.get(datasetId)?.highWater ?? 0), before = organizationBarrier(db)
        if (revision !== expectedRevision) return changed()
        let active = true
        const check = () => {
          assertActive()
          if (!active || !artistIndexLyricsReading || !db.isTransaction || workbenchAudits.get(db) !== audit
            || String(audit.lyrics.get(datasetId)?.highWater ?? 0) !== revision) return changed()
        }
        const view: LocalAlbumLyricsInventory = Object.freeze({ revision: () => { check(); return revision },
          read: (trackId: string, rootId: string, fileRevision: string): dto.LocalLyricsPresence => {
            check()
            const fact = audit.lyrics.get(datasetId)?.inventory.get(trackId)
            return fact && fact.rootId === rootId && fact.fileRevision === fileRevision ? fact.presence : 'unknown'
          } })
        artistIndexLyricsReading = true
        try {
          check()
          const result = read(view)
          if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') return changed()
          check()
          if (workbenchProjectionFor(db) !== audit || organizationBarrier(db) !== before
            || db.prepare('PRAGMA query_only').get()?.query_only !== 1 || db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0) return changed()
          return result
        } finally { active = false; artistIndexLyricsReading = false }
      })
    },
    privateWithLyricsInventoryRead: withLyricsInventoryRead,
    privateLyricsInventoryRead(datasetId:string,trackId:string,rootId:string,fileRevision:string):dto.LocalLyricsPresence{
      // 只有原同步scope的稳定撤销作者才省去逐曲FS；scope外、无SAB及显式事务沿原完整guard。
      const current = lyricsInventoryReadScope
      if (!current?.assertActive) assertWorkbenchDataset(datasetId)
      return access.read(db=>{if(current)checkLyricsInventoryRead(current,db,datasetId);const audited=workbenchAudits.get(db);if(!audited)return corrupt();const fact=audited.lyrics.get(datasetId)?.inventory.get(trackId);return fact&&fact.rootId===rootId&&fact.fileRevision===fileRevision?fact.presence:'unknown'})
    },
    privateRelocationPrepareReads(request: RelocationScanReadRequest, readAccess: RelocationReadAccess, signal: AbortSignal): Promise<PreparedRelocationReads> {
      return access.read(db => { certificateFor(db); return prepareRelocationScanReads(db, request, readAccess, signal); });
    },
    privateRelocationRead<T>(operation: (view: RelocationReadView) => T): T {
      return access.read(db => operation(relocationView(db, copyRelocationProjection(relocationProjectionFor(db)))));
    },
    /** 原目录作者唯一短事务：位置CAS、真实Scanner来源及本域journal一起落地。 */
    privateRelocationTransaction<T>(operation: (view: RelocationWriteView) => T): T {
      return access.read(db => {
        db.exec('BEGIN IMMEDIATE'); let committed = false;
        try {
          const projection = copyRelocationProjection(relocationProjectionFor(db));
          let certificate = certificateFor(db), changed = 0;
          const publishes: (() => void)[] = [], appended: RelocationEvent[] = [], requiredFacts: RelocationLocationFact[] = [];
          const requiredRoots: { before: dto.LibraryRoot; after: dto.LibraryRoot }[] = [];
          const beforeChanges = Number(db.prepare('SELECT total_changes() n').get()!.n);
          const append = (event: RelocationEvent): void => {
            if (appended.length >= dto.LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerPlan) return relocationFail('OVER_BUDGET');
            const row = relocationLedgerRow(event); boundedRow(row);
            if (db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!)) return relocationFail('REVISION_CONFLICT');
            const rows = new Map(certificate.rows), count = rows.get('local_catalog_ledger')! + 1, bytes = certificate.bytes + rowBytes(row);
            checkBudget('local_catalog_ledger行数', count, rowBudgets.local_catalog_ledger); checkBudget('目录总文本字节', bytes, maxCatalogTextBytes);
            const inserted = db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id!, row.fingerprint!, row.operation!, row.request!, row.result!, row.created_at!);
            projectRelocationEvent(projection, event, Number(inserted.lastInsertRowid));
            readRelocationEvent(db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(row.command_id!)!);
            rows.set('local_catalog_ledger', count); certificate = { rows, bytes, dataVersion: certificate.dataVersion }; changed++; appended.push(event);
          };
          const view: RelocationWriteView = { ...relocationView(db, projection), append, commitLocations: input => {
            if (!dto.localRelocationRecord(input, ['commandId', 'requestFingerprint', 'planId', 'planHash', 'resourceClosureHash', 'mappings', 'reads', 'readAccess', 'rootRelink', 'mappingProofs'])
              || !dto.isCollectionId(input.commandId) || !dto.isLocalRelocationPlanHash(input.requestFingerprint)
              || input.mappings.length < 1 || input.mappings.length > dto.LOCAL_RELOCATION_PLAN_BUDGET.operations || requiredFacts.length) return relocationFail('INVALID_REQUEST');
            const stored = projection.plans.get(input.planId), actualTargets = relocationReadAccessTargets(input.readAccess);
            if (!stored?.ready || stored.plan.planHash !== input.planHash || stored.plan.closure.fingerprint !== input.resourceClosureHash
              || input.mappingProofs.length !== input.mappings.length || new Set(input.mappingProofs.map(proof => proof.resourceId)).size !== input.mappingProofs.length
              || new Set(input.mappings.map(mapping => mapping.beforeAsset.id)).size !== input.mappings.length) return relocationFail('REVISION_CONFLICT');
            const audio = stored.resources.filter(resource => resource.frozen.role === 'AUDIO');
            if (audio.length !== input.mappings.length || audio.some(resource => !input.mappings.some(mapping => mapping.resourceId === resource.frozen.resourceId))) return relocationFail('CLOSURE_INCOMPLETE');
            const rootRelink = input.rootRelink;
            if (rootRelink) {
              const current = one(db, 'local_catalog_roots', rootRelink.before.id); boundedRow(current);
              if (!relocationRootReassociationMatches(projection, stored, rootRelink.before, rootRelink.after)
                || !same(readRoot(current), rootRelink.before) || !same(rootRelink.after, { ...rootRelink.before, sourceRootId: rootRelink.after.sourceRootId, revision: next(rootRelink.before.revision) })
                || rootRelink.after.sourceRootId === rootRelink.before.sourceRootId) return relocationFail('ROOT_CHANGED');
              const members = db.prepare('SELECT id FROM local_catalog_assets WHERE root_id=? ORDER BY rowid LIMIT 101').all(rootRelink.before.id);
              if (members.length > dto.LOCAL_RELOCATION_PLAN_BUDGET.operations) return relocationFail('OVER_BUDGET');
              if (members.length !== input.mappings.length || members.some(member => !input.mappings.some(mapping => mapping.beforeAsset.id === member.id))) return relocationFail('CLOSURE_INCOMPLETE');
              overlap(db, authorized(rootRelink.after.sourceRootId), rootRelink.before.id);
              const afterRow = { ...current, source_root_id: rootRelink.after.sourceRootId, data: JSON.stringify(rootRelink.after) }; boundedRow(afterRow);
              db.prepare('UPDATE local_catalog_roots SET source_root_id=?,data=? WHERE id=? AND data=?').run(rootRelink.after.sourceRootId, afterRow.data, rootRelink.before.id, current.data as string);
              if (!same(root(db, rootRelink.after.id), rootRelink.after)) return relocationFail('ROOT_CHANGED');
              const bytes = certificate.bytes + rowBytes(afterRow) - rowBytes(current); checkBudget('目录总文本字节', bytes, maxCatalogTextBytes);
              certificate = { ...certificate, bytes }; changed++; requiredRoots.push(rootRelink);
            } else if (stored.plan.intent.kind === 'root-reassociate') return relocationFail('INVALID_REQUEST');
            const nextAssets: dto.AudioAsset[] = [];
            for (const mapping of input.mappings) {
              const captured = stored.operations.find(value => value.operation.operationId === mapping.operationId)?.source;
              const resource = audio.find(value => value.frozen.resourceId === mapping.resourceId), proof = input.mappingProofs.find(value => value.resourceId === mapping.resourceId);
              const current = one(db, 'local_catalog_assets', mapping.beforeAsset.id); boundedRow(current);
              const old = readAsset(current), source = rootRelink?.before.id === old.libraryRootId ? rootRelink.before : root(db, old.libraryRootId);
              const target = currentRoot(db, mapping.destination.libraryRootId, mapping.destination.rootRevision);
              const targetRead = actualTargets.find(value => value.path.root.id === mapping.destination.sourceRootId && value.path.relative === mapping.destination.relative);
              const tracks = db.prepare('SELECT * FROM local_catalog_tracks WHERE asset_id=? ORDER BY rowid LIMIT 201').all(old.id);
              if (tracks.length > maxCatalogReadRows) return relocationFail('OVER_BUDGET');
              if (!captured || !resource || !proof || !targetRead || target.sourceRootId !== mapping.destination.sourceRootId || !relativePath(mapping.destination.relative)
                || !same(old, mapping.beforeAsset) || !same(old, captured.asset) || !same(source, captured.libraryRoot)
                || current.relative !== captured.relative || current.sha256 !== captured.catalogSha256
                || !same(tracks.map(readTrack), mapping.tracks) || !same(mapping.tracks, captured.tracks)
                || source.sourceRootId !== old.sourceRootId || source.revision !== old.rootRevision
                || resource.frozen.operationIds.length !== 1 || resource.frozen.operationIds[0] !== mapping.operationId
                || resource.frozen.source.libraryRootId !== source.id || resource.frozen.source.sourceRootId !== source.sourceRootId
                || resource.frozen.source.expectedRootRevision !== source.revision || resource.frozen.source.relative !== captured.relative
                || resource.frozen.target.libraryRootId !== target.id || resource.frozen.target.sourceRootId !== target.sourceRootId
                || resource.frozen.target.expectedRootRevision !== target.revision || resource.frozen.target.relative !== mapping.destination.relative
                || !same(proof.sourceObservation, resource.sourceObservation) || !same(proof.targetObservation, targetRead.observation)
                || proof.sourceObservation.sha256 !== resource.frozen.before.sha256 || proof.targetObservation.sha256 !== resource.frozen.after.sha256
                || proof.sourceObservation.sha256 !== proof.targetObservation.sha256 || proof.sourceObservation.bytes !== proof.targetObservation.bytes
                || captured.catalogSha256 !== null && captured.catalogSha256 !== proof.sourceObservation.sha256) return relocationFail('REVISION_CONFLICT');
              authorized(source.sourceRootId);
              const collision = db.prepare('SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? AND id<>? LIMIT 1').get(target.id, mapping.destination.relative, old.id);
              if (collision) return relocationFail('COLLISION');
              const updated: dto.AudioAsset = { ...old, libraryRootId: target.id, sourceRootId: target.sourceRootId, rootRevision: target.revision, locationRevision: next(old.locationRevision) };
              for (const localTrack of mapping.tracks) checkSegment(localTrack, updated);
              const afterRow = { ...current, root_id: target.id, source_root_id: target.sourceRootId, relative: mapping.destination.relative, data: JSON.stringify(updated) }; boundedRow(afterRow);
              const result = db.prepare('UPDATE local_catalog_assets SET root_id=?,source_root_id=?,relative=?,data=? WHERE id=? AND data=? AND relative=? AND sha256 IS ?').run(target.id, target.sourceRootId, mapping.destination.relative, afterRow.data, old.id, current.data as string, current.relative as string, current.sha256 as string | null);
              if (result.changes !== 1 || !same(asset(db, old.id), updated)) return relocationFail('REVISION_CONFLICT');
              const bytes = certificate.bytes + rowBytes(afterRow) - rowBytes(current); checkBudget('目录总文本字节', bytes, maxCatalogTextBytes);
              certificate = { ...certificate, bytes }; changed++; nextAssets.push(updated);
            }
            const request: RelocationScanReadRequest = { datasetId: stored.plan.datasetId, planId: input.planId, planHash: input.planHash, resourceClosureHash: input.resourceClosureHash, mappings: input.mappings };
            const scan = applyRelocationScanFacts(db, { ...request, commitCommandId: input.commandId, afterAssets: nextAssets }, input.reads);
            changed += scan.changedRows; publishes.push(scan.publish);
            const facts: RelocationLocationFact[] = input.mappings.map((mapping, index) => {
              const captured = stored.operations.find(value => value.operation.operationId === mapping.operationId)!.source!, proof = input.mappingProofs.find(value => value.resourceId === mapping.resourceId)!;
              const scanner = scan.facts[index]; if (!scanner || scanner.resourceId !== mapping.resourceId || scanner.operationId !== mapping.operationId) return corrupt();
              return { operationId: mapping.operationId, resourceId: mapping.resourceId, planHash: input.planHash, resourceClosureHash: input.resourceClosureHash,
                beforeAsset: captured.asset, afterAsset: nextAssets[index]!, tracks: captured.tracks, catalogSha256: captured.catalogSha256,
                source: { libraryRootId: captured.libraryRoot.id, sourceRootId: captured.libraryRoot.sourceRootId, rootRevision: captured.libraryRoot.revision, relative: captured.relative },
                target: mapping.destination, sourceObservation: proof.sourceObservation, targetObservation: proof.targetObservation, scan: scanner };
            });
            requiredFacts.push(...facts); return { assets: nextAssets, scan, facts };
          } };
          const result = operation(view); if (result instanceof Promise) return corrupt();
          for (const fact of requiredFacts) if (appended.filter(event => event.kind === 'location-facts' && relocationCanonical(event.fact) === relocationCanonical(fact)).length !== 1) return corrupt();
          for (const roots of requiredRoots) if (appended.filter(event => event.kind === 'root-facts' && same(event.beforeRoot, roots.before) && same(event.afterRoot, roots.after)).length !== 1) return corrupt();
          if (Number(db.prepare('SELECT total_changes() n').get()!.n) !== beforeChanges + changed) return corrupt();
          access.beforeCommit?.('local-relocation:append');
          if (Number(db.prepare('SELECT total_changes() n').get()!.n) !== beforeChanges + changed) return corrupt();
          access.beforeLocalFactsCommit?.(); commitLocalFacts(db, access.onLocalFactsFatal); committed = true;
          audits.set(db, certificate); relocationAudits.set(db, projection); publishes.forEach(publish => publish()); return result;
        } catch (error) {
          if (committed) { access.onLocalFactsFatal?.(); throw new LocalFactsCommitFatal(); }
          rollbackLocalFacts(db, error, access.onLocalFactsFatal);
        }
      });
    },
    /** 关闭晚期只读核验；临时冷投影不升级普通warm凭证，也不能接纳另一作者的新Source历史。 */
    privateSourceWritesClosingRead(identity:DatasetIdentity,judge:(projection:SourceWritesProjection)=>boolean):boolean {
      assertWorkbenchIdentity(identity);
      return access.read(db=>{
        const oldAudit=audits.get(db),oldLegacy=legacyAudits.get(db),oldSource=sourceWritesAudits.get(db),
          oldRelocation=relocationAudits.get(db),oldWorkbench=workbenchAudits.get(db),oldObservations=observationHistoryAudits.get(db);
        if(!oldAudit||!oldSource)return sourceWritesFail('RECOVERY_REQUIRED');
        if(dataVersion(db)===oldAudit.dataVersion){
          const beforeChanges=Number(db.prepare('SELECT total_changes() n').get()?.n),beforeQueryOnly=db.prepare('PRAGMA query_only').get()?.query_only;
          if(!Number.isSafeInteger(beforeChanges)||(beforeQueryOnly!==0&&beforeQueryOnly!==1))return sourceWritesFail('RECOVERY_REQUIRED');
          const result=judge(copySourceWritesProjection(sourceProjectionFor(db)));
          if(typeof result!=='boolean'||dataVersion(db)!==oldAudit.dataVersion
            ||Number(db.prepare('SELECT total_changes() n').get()?.n)!==beforeChanges
            ||db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1||db.prepare('PRAGMA query_only').get()?.query_only!==beforeQueryOnly)
            return sourceWritesFail('RECOVERY_REQUIRED');
          assertWorkbenchIdentity(identity);return result;
        }
        const beforeVersion=dataVersion(db),beforeChanges=Number(db.prepare('SELECT total_changes() n').get()?.n),
          beforeQueryOnly=db.prepare('PRAGMA query_only').get()?.query_only;
        if(!Number.isSafeInteger(beforeVersion)||!Number.isSafeInteger(beforeChanges)
          ||(beforeQueryOnly!==0&&beforeQueryOnly!==1)||db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1)
          return sourceWritesFail('RECOVERY_REQUIRED');
        let began=false,result=false;const failures:unknown[]=[];
        try {
          // BEGIN冲突时不回滚调用者的事务；只结束本方法成功建立的只读快照。
          db.exec('BEGIN');began=true;db.exec('PRAGMA query_only=ON');
          if(dataVersion(db)!==beforeVersion||db.prepare('PRAGMA query_only').get()?.query_only!==1)
            return sourceWritesFail('RECOVERY_REQUIRED');
          verifyLocalCatalogDatabase(db);
          const temporary=sourceWritesAudits.get(db);
          if(!temporary||temporary.highWater<oldSource.highWater||temporary.bytes!==oldSource.bytes
            ||temporary.fingerprint!==oldSource.fingerprint||temporary.events.length!==oldSource.events.length
            ||temporary.events.some((event,index)=>!same(sourceWritesLedgerRow(event),sourceWritesLedgerRow(oldSource.events[index]!))))
            return sourceWritesFail('RECOVERY_REQUIRED');
          assertWorkbenchIdentity(identity);result=judge(copySourceWritesProjection(temporary));
          if(typeof result!=='boolean'||dataVersion(db)!==beforeVersion
            ||Number(db.prepare('SELECT total_changes() n').get()?.n)!==beforeChanges
            ||db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1||db.prepare('PRAGMA query_only').get()?.query_only!==1)
            return sourceWritesFail('RECOVERY_REQUIRED');
        }catch(error){failures.push(error);}
        finally {
          if(began)try{db.exec('ROLLBACK');}catch(error){failures.push(error);}
          try{
            db.exec(beforeQueryOnly===1?'PRAGMA query_only=ON':'PRAGMA query_only=OFF');
            if(dataVersion(db)!==beforeVersion||Number(db.prepare('SELECT total_changes() n').get()?.n)!==beforeChanges
              ||db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1||db.prepare('PRAGMA query_only').get()?.query_only!==beforeQueryOnly)
              sourceWritesFail('RECOVERY_REQUIRED');
            assertWorkbenchIdentity(identity);
          }catch(error){failures.push(error);}
          // 原缓存与纯观察关系作者逐一恢复原引用；临时只读冷核不能升级普通warm作者。
          audits.set(db,oldAudit);sourceWritesAudits.set(db,oldSource);
          if(oldLegacy===undefined)legacyAudits.delete(db);else legacyAudits.set(db,oldLegacy);
          if(oldRelocation===undefined)relocationAudits.delete(db);else relocationAudits.set(db,oldRelocation);
          if(oldWorkbench===undefined)workbenchAudits.delete(db);else workbenchAudits.set(db,oldWorkbench);
          if(oldObservations===undefined)observationHistoryAudits.delete(db);else observationHistoryAudits.set(db,oldObservations);
        }
        if(failures.length===1)throw failures[0];
        if(failures.length>1)throw new AggregateError(failures,'Source关闭只读核验与收尾失败；原凭证和数据保留。');
        return result;
      });
    },
    privateSourceWritesRead<T>(operation:(view:SourceWritesReadView)=>T):T{return access.read(db=>operation(sourceView(db,copySourceWritesProjection(sourceProjectionFor(db)))));},
    privateSourceWritesTransaction<T>(operation:(view:SourceWritesWriteView)=>T):T{
      return access.read(db=>{db.exec('BEGIN IMMEDIATE');let committed=false;try{
        const projection=copySourceWritesProjection(sourceProjectionFor(db));let certificate=certificateFor(db),changed=0,added=0;const publishes:(()=>void)[]=[];
        const before=Number(db.prepare('SELECT total_changes() n').get()!.n);
        const append=(event:SourceWritesEvent):void=>{
          if(added>=512)return sourceWritesFail('BUDGET_EXCEEDED');const row=sourceWritesLedgerRow(event),{command_id,fingerprint,operation,request,result,created_at}=row;if(typeof command_id!=='string'||typeof fingerprint!=='string'||typeof operation!=='string'||typeof request!=='string'||typeof result!=='string'||typeof created_at!=='string')return sourceWritesFail('INVALID_REQUEST');if(db.prepare('SELECT command_id FROM local_catalog_ledger WHERE command_id=?').get(command_id))return sourceWritesFail('COMMAND_ID_REUSED');
          const rows=new Map(certificate.rows),count=rows.get('local_catalog_ledger')!+1,bytes=certificate.bytes+rowBytes(row);checkBudget('local_catalog_ledger行数',count,rowBudgets.local_catalog_ledger);checkBudget('目录总文本字节',bytes,maxCatalogTextBytes);
          const inserted=db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(command_id,fingerprint,operation,request,result,created_at),ordinal=Number(inserted.lastInsertRowid);projectSourceWritesEvent(projection,event,ordinal);readSourceWritesEvent(db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(command_id)!);rows.set('local_catalog_ledger',count);certificate={rows,bytes,dataVersion:certificate.dataVersion};changed++;added++;
        };
        const view:SourceWritesWriteView={...sourceView(db,projection),append,finalize:event=>{
          const fact=event.fact,stored=projection.plans.get(event.planId!);if(!stored||stored.plan.range==='DIRECTORY_COVER')return sourceWritesFail('INVALID_REQUEST');const selected=stored.items.find(i=>i.item.operationId===fact.operationId);if(!selected)return sourceWritesFail('INVALID_REQUEST');const c=selected.capture;
          const current=asset(db,c.asset.id);if(!same(current,c.asset))return sourceWritesFail('REVISION_CHANGED');
          const request:ReplaceAudioAsset={commandId:fact.replaceCommandId,libraryRootId:c.libraryRoot.id,expectedRootRevision:c.libraryRoot.revision,relative:c.relative,sha256:fact.observation.sha256,sampleFrames:current.sampleFrames,timebaseHz:current.timebaseHz,assetId:current.id,expectedFileRevision:current.fileRevision,expectedLocationRevision:current.locationRevision};
          const prior=Number(db.prepare('SELECT total_changes() n').get()!.n),candidate=mutate(db,certificate,'replace-asset',request,d=>applyReplaceAsset(d,request));certificate=candidate.certificate;changed+=Number(db.prepare('SELECT total_changes() n').get()!.n)-prior;if(!same(candidate.result,fact.afterAsset))return corrupt();
          publishes.push(updateSourceWriteScanFacts(db,c.libraryRoot.id,c.relative,c.scan.jobId,c.scan.batchId,fact.scanBefore,fact.scanAfter));changed++;append(event);return candidate.result as dto.AudioAsset;
        }};
        const result=operation(view);if(result instanceof Promise)return corrupt();if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+changed)return corrupt();access.beforeCommit?.('local-source-writes:append');if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+changed)return corrupt();access.beforeLocalFactsCommit?.();commitLocalFacts(db,access.onLocalFactsFatal);committed=true;audits.set(db,certificate);sourceWritesAudits.set(db,projection);publishes.forEach(p=>p());return result;
      }catch(error){if(committed){access.onLocalFactsFatal?.();throw new LocalFactsCommitFatal();}rollbackLocalFacts(db,error,access.onLocalFactsFatal);}});
    },
    /** 新域只能读取已认证投影；不向关系服务提供 raw db 或原 mutate。 */
    privateLegacyLinksRead<T>(operation:(view:LegacyLinksView)=>T):T {return access.read(db=>operation(legacyView(db,legacyProjectionFor(db))));},
    privateLegacyLinksTransaction<T>(operation:(view:LegacyLinksWriteView)=>T):T {
      return access.read(db=>{
        db.exec('BEGIN IMMEDIATE');
        try{
          const projection=copyLegacyLinksProjection(legacyProjectionFor(db));let certificate=certificateFor(db),added=0;
          const before=Number(db.prepare('SELECT total_changes() n').get()!.n);
          const view:LegacyLinksWriteView={...legacyView(db,projection),append:(event:LegacyLinksEvent)=>{
            if(!isLegacyLinksEvent(event)||added>=1)return legacyLinksFail('INVALID_REQUEST');
            if(db.prepare('SELECT command_id FROM local_catalog_ledger WHERE command_id=?').get(event.request.commandId))return legacyLinksFail('COMMAND_ID_REUSED');
            const result=event.kind==='preview'?event.preview:event.receipt;
            const row={command_id:event.request.commandId,fingerprint:event.requestFingerprint,operation:LOCAL_LEGACY_LINKS_OPERATION,request:dto.localLegacyLinksCanonical(event),result:dto.localLegacyLinksCanonical(result),created_at:event.occurredAt};
            boundedRow(row);const rows=new Map(certificate.rows),count=rows.get('local_catalog_ledger')!+1,bytes=certificate.bytes+rowBytes(row);
            checkBudget('local_catalog_ledger行数',count,rowBudgets.local_catalog_ledger);checkBudget('目录总文本字节',bytes,maxCatalogTextBytes);
            projectLegacyLinksEvent(projection,event);
            const inserted=db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(row.command_id,row.fingerprint,row.operation,row.request,row.result,row.created_at);
            const n=Number(inserted.lastInsertRowid);if(!Number.isSafeInteger(n)||n<=projection.highWater)return corrupt();projection.highWater=n;
            const stored=db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(row.command_id)!;boundedRow(stored);readLegacyLinksEvent(stored);
            rows.set('local_catalog_ledger',count);certificate={rows,bytes,dataVersion:certificate.dataVersion};added++;
          }};
          const result=operation(view);if(result instanceof Promise)return corrupt();
          if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+added)return corrupt();
          access.beforeCommit?.('local-legacy-links:append');
          if(Number(db.prepare('SELECT total_changes() n').get()!.n)!==before+added)return corrupt();
          access.beforeLocalFactsCommit?.();commitLocalFacts(db,access.onLocalFactsFatal);
          audits.set(db,certificate);legacyAudits.set(db,projection);return result;
        }catch(error){rollbackLocalFacts(db,error,access.onLocalFactsFatal);}
      });
    },
    privateLegacyLinksAssetSnapshot(assetId:string,trackId:string):import('./local-legacy-links-journal.js').LegacyLinksAssetSnapshot {
      id(assetId);id(trackId);return access.read(db=>{certificateFor(db);const row=one(db,'local_catalog_assets',assetId),a=readAsset(row);boundedRow(row);if(!relativePath(row.relative)||!sha(row.sha256))return corrupt();return {asset:a,track:track(db,trackId),libraryRoot:root(db,a.libraryRootId),relative:row.relative,catalogSha256:row.sha256 as string|null};});
    },
    /** Node owner唯一连接的私有批提交接点；callback必须同步，不读取文件、不返回Promise。 */
    privateRead<T>(operation: (db: DatabaseSync) => T): T { return access.read(db => { certificateFor(db); return operation(db); }); },
    privateBatch<T>(operation: (db: DatabaseSync, mutate: (name: dto.LocalCatalogOperation, request: Command & Row) => dto.LocalCatalogResult, appendJournal: (event: OrganizerEvent) => void) => T, action = 'local-scan:commit-batch', scanDelta?: LocalAlbumScanDelta): T {
      return access.read(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          let certificate = certificateFor(db);
          let expectedChanges = Number(db.prepare('SELECT total_changes() n').get()?.n);
          const initialChanges = expectedChanges;
          if(action!=='local-scan:commit-batch')invalidateLocalAlbumScanDelta(scanDelta);
          const journalRows: Row[] = [];
          const acceptedMutation = (candidate: { result: dto.LocalCatalogResult; certificate: AuditCertificate; changed: boolean }): dto.LocalCatalogResult => {
            certificate = candidate.certificate;
            // 原mutate已逐行回读实体和子账本并核恰好两次写入；回执重放没有新写。
            expectedChanges += candidate.changed ? 2 : 0;
            return candidate.result;
          };
          const applyMutation = (name: dto.LocalCatalogOperation, request: Command & Row): dto.LocalCatalogResult => {
            const operation = name;
            if (!validRequest(operation, request)) return access.conflict('本地目录私有批请求无效。');
            if(!['register-asset','replace-asset','create-track','observe-metadata'].includes(operation))invalidateLocalAlbumScanDelta(scanDelta);
            if(scanDelta&&operation==='replace-asset'){
              const previous=db.prepare('SELECT root_id,relative FROM local_catalog_assets WHERE id=?').get(String(request.assetId));
              if(!previous||previous.root_id!==request.libraryRootId||previous.relative!==request.relative)invalidateLocalAlbumScanDelta(scanDelta);
            }
            switch (operation) {
              case 'register-root': { const candidate = mutate(db, certificate, operation, request, d => applyRegisterRoot(d, request as unknown as RegisterLibraryRoot)); return acceptedMutation(candidate); }
              case 'relink-root': { const candidate = mutate(db, certificate, operation, request, d => applyRelinkRoot(d, request as unknown as RelinkLibraryRoot)); return acceptedMutation(candidate); }
              case 'register-asset': { const candidate = mutate(db, certificate, operation, request, d => applyRegisterAsset(d, request as unknown as RegisterAudioAsset)); return acceptedMutation(candidate); }
              case 'move-asset': { const candidate = mutate(db, certificate, operation, request, d => applyMoveAsset(d, request as unknown as MoveAudioAsset)); return acceptedMutation(candidate); }
              case 'replace-asset': { const candidate = mutate(db, certificate, operation, request, d => applyReplaceAsset(d, request as unknown as ReplaceAudioAsset)); return acceptedMutation(candidate); }
              case 'create-track': { const candidate = mutate(db, certificate, operation, request, d => applyCreateTrack(d, request as unknown as CreateLocalTrack)); return acceptedMutation(candidate); }
              case 'select-asset': { const candidate = mutate(db, certificate, operation, request, d => applySelectAsset(d, request as unknown as SelectLocalAsset)); return acceptedMutation(candidate); }
              case 'create-edition': { const candidate = mutate(db, certificate, operation, request, d => applyCreateEdition(d, request as unknown as CreateAlbumEdition)); return acceptedMutation(candidate); }
              case 'link-edition-track': { const candidate = mutate(db, certificate, operation, request, d => applyLinkEditionTrack(d, request as unknown as LinkEditionTrack)); return acceptedMutation(candidate); }
              case 'remove-edition-track': { const candidate = mutate(db, certificate, operation, request, d => applyRemoveEditionTrack(d, request as unknown as RemoveEditionTrack)); return acceptedMutation(candidate); }
              case 'observe-metadata': { const candidate = mutate(db, certificate, operation, request, d => applyObserveMetadata(d, request as unknown as ObserveLocalMetadata)); return acceptedMutation(candidate); }
              case 'override-metadata': { const candidate = mutate(db, certificate, operation, request, d => applyOverrideMetadata(d, request as unknown as OverrideLocalMetadata)); return acceptedMutation(candidate); }
            }
          };
          const apply = applyMutation;
          const appendJournal = (event: OrganizerEvent): void => {
            invalidateLocalAlbumScanDelta(scanDelta);
            if (!isOrganizerEvent(event)) return corrupt();
            const digest = organizerHash(event), previous = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(event.eventId);
            if (previous) { if (previous.operation !== ORGANIZER_JOURNAL || previous.fingerprint !== digest) return access.conflict('整理事件编号已绑定其他内容。'); readOrganizerEvent(previous); return; }
            if (journalRows.length >= 256) throw new LocalCatalogBudgetError('单事务整理事件', journalRows.length + 1, 256);
            db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(event.eventId, digest, ORGANIZER_JOURNAL, organizerCanonical(event), organizerCanonical({ eventId: event.eventId, eventHash: digest }), new Date().toISOString());
            const row = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(event.eventId)!; boundedRow(row); readOrganizerEvent(row);
            const counts = new Map(certificate.rows), count = counts.get('local_catalog_ledger')! + 1;
            checkBudget('local_catalog_ledger行数', count, rowBudgets.local_catalog_ledger); counts.set('local_catalog_ledger', count);
            const bytes = certificate.bytes + rowBytes(row); checkBudget('目录总文本字节', bytes, maxCatalogTextBytes);
            certificate = { rows: counts, bytes, dataVersion: certificate.dataVersion }; journalRows.push(row); expectedChanges++;
          };
          const result = operation(db, apply, appendJournal);
          if (result instanceof Promise) return corrupt();
          for (const row of journalRows) verifyOrganizerJournalRow(db, row);
          // Scanner在原批事务中还写自己的检查点/文件事实，由其原审计负责；整理只允许目录和私有事件。
          if (action.startsWith('local-organizer:') && Number(db.prepare('SELECT total_changes() n').get()?.n) !== expectedChanges) return corrupt();
          access.beforeCommit?.(action);
          if (action.startsWith('local-organizer:') && Number(db.prepare('SELECT total_changes() n').get()?.n) !== expectedChanges) return corrupt();
          access.beforeLocalFactsCommit?.();
          approveLocalAlbumScanDelta(db, scanDelta, expectedChanges-initialChanges);
          commitLocalFacts(db,access.onLocalFactsFatal); audits.set(db, certificate); return result;
        } catch (error) { discardLocalAlbumScanDelta(scanDelta); rollbackLocalFacts(db,error,access.onLocalFactsFatal); }
      });
    },
    registerRoot(request: RegisterLibraryRoot): dto.LibraryRoot { return transaction('register-root', request, db => applyRegisterRoot(db, request)); },
    relinkRoot(request: RelinkLibraryRoot): dto.LibraryRoot { return transaction('relink-root', request, db => applyRelinkRoot(db, request)); },
    root(rootId: string): dto.LibraryRoot { id(rootId); return access.read(db => root(db, rootId)); },
    roots(): dto.LibraryRoot[] { return access.read(db => db.prepare('SELECT * FROM local_catalog_roots ORDER BY rowid').all().map(readRoot)); },
    registerAsset(request: RegisterAudioAsset): dto.AudioAsset { return transaction('register-asset', request, db => applyRegisterAsset(db, request)); },
    moveAsset(request: MoveAudioAsset): dto.AudioAsset { return transaction('move-asset', request, db => applyMoveAsset(db, request)); },
    replaceAsset(request: ReplaceAudioAsset): dto.AudioAsset { return transaction('replace-asset', request, db => applyReplaceAsset(db, request)); },
    asset(assetId: string): dto.AudioAsset { id(assetId); return access.read(db => asset(db, assetId)); },
    /** 仅Node owner私有准备接点；不经公开DTO/IPC暴露locator，也不新增授权真相。 */
    privateAssetLocator(assetId: string): { asset: dto.AudioAsset; relative: string } {
      id(assetId); return access.read(db => {
        const row = one(db, 'local_catalog_assets', assetId); boundedRow(row);
        const selected = readAsset(row); if (!relativePath(row.relative)) return corrupt();
        return { asset: { ...selected }, relative: row.relative };
      });
    },
    /** 013同内容移动的完整原事实；不授予文件写权限，也不补造旧整文件Hash。 */
    privateRelocationSnapshot(assetId: string): { asset: dto.AudioAsset; libraryRoot: dto.LibraryRoot; relative: string; catalogSha256: string | null; tracks: dto.LocalTrack[] } {
      id(assetId); return access.read(db => {
        certificateFor(db);
        return relocationMember(db, one(db, 'local_catalog_assets', assetId));
      });
    },
    /** 整根操作必须看到全部成员；101哨兵只用于整组拒绝，不截成100项计划。 */
    privateRelocationRootMembers(libraryRootId: string): { asset: dto.AudioAsset; libraryRoot: dto.LibraryRoot; relative: string; catalogSha256: string | null; tracks: dto.LocalTrack[] }[] {
      id(libraryRootId); return access.read(db => {
        certificateFor(db); root(db, libraryRootId);
        const rows = db.prepare('SELECT * FROM local_catalog_assets WHERE root_id=? ORDER BY rowid LIMIT 101').all(libraryRootId);
        if (rows.length > 100) throw new LocalCatalogBudgetError('移动整根完整资产集合', rows.length, 100);
        return rows.map(row => relocationMember(db, row));
      });
    },
    /** 同目录共享伴随闭集的独立013上限；原公开分页和012目录读预算保持。 */
    privateRelocationDirectoryMembers(libraryRootId: string, directory: string): { asset: dto.AudioAsset; libraryRoot: dto.LibraryRoot; relative: string; catalogSha256: string | null; tracks: dto.LocalTrack[] }[] {
      id(libraryRootId);
      if (directory !== '.' && !relativePath(directory)) return access.conflict('移动目录范围无效。');
      return access.read(db => {
        certificateFor(db); root(db, libraryRootId);
        const prefix = directory === '.' ? '' : `${directory}/`;
        const rows = db.prepare("SELECT * FROM local_catalog_assets WHERE root_id=? AND substr(relative,1,length(?))=? AND instr(substr(relative,length(?)+1),'/')=0 ORDER BY rowid LIMIT 257").all(libraryRootId, prefix, prefix, prefix);
        if (rows.length > 256) throw new LocalCatalogBudgetError('移动目录伴随完整资产集合', rows.length, 256);
        return rows.map(row => relocationMember(db, row));
      });
    },
    /** 本轮源动作的共享影响闭集；普通200曲读预算不变。 */
    privateSourceWriteTracks(assetId:string):dto.LocalTrack[]{id(assetId);return access.read(db=>{const rows=db.prepare('SELECT * FROM local_catalog_tracks WHERE asset_id=? ORDER BY rowid LIMIT 201').all(assetId);if(rows.length>200)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');return rows.map(readTrack);});},
    privateSourceWriteDirectory(rootId:string,directory:string):{asset:dto.AudioAsset;relative:string;tracks:dto.LocalTrack[]}[]{
      id(rootId);return access.read(db=>{const prefix=directory==='.'?'':`${directory}/`,rows=db.prepare('SELECT * FROM local_catalog_assets WHERE root_id=? AND substr(relative,1,length(?))=? AND instr(substr(relative,length(?)+1),\'/\')=0 ORDER BY rowid LIMIT 201').all(rootId,prefix,prefix,prefix);if(rows.length>200)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');return rows.map(row=>{boundedRow(row);const selected=readAsset(row),tracks=db.prepare('SELECT * FROM local_catalog_tracks WHERE asset_id=? ORDER BY rowid LIMIT 201').all(selected.id);if(tracks.length>200)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');return {asset:selected,relative:String(row.relative),tracks:tracks.map(readTrack)};});});
    },
    createTrack(request: CreateLocalTrack): dto.LocalTrack { return transaction('create-track', request, db => applyCreateTrack(db, request)); },
    selectAsset(request: SelectLocalAsset): dto.LocalTrack { return transaction('select-asset', request, db => applySelectAsset(db, request)); },
    track(trackId: string): dto.LocalTrack { id(trackId); return access.read(db => track(db, trackId)); },
    pageTracks(page: dto.PageRequest): dto.Page<dto.LocalTrack> {
      if (!record(page) || !keys(page, ['offset', 'limit']) || !Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 200) return access.conflict('本地目录分页无效。');
      return access.read(db => { const total = Number(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n), items = db.prepare('SELECT * FROM local_catalog_tracks ORDER BY rowid LIMIT ? OFFSET ?').all(page.limit, page.offset).map(readTrack); return { ...page, total, items, hasMore: page.offset + items.length < total }; });
    },
    /** 专辑浏览复用同一作者的 raw/effective 水位；不分配文件许可或新连接。 */
    privateAlbumBrowserRevision(): string { return access.read(db => { certificateFor(db); return albumCatalogRevision(db); }); },
    /** 原字段覆盖与最新真实目录命令对账；操作名本身不冒充人工或AI作者。 */
    privateWorkbenchMetadataProvenance(trackIds: readonly string[]): LocalWorkbenchMetadataProvenanceFact[] {
      if (!Array.isArray(trackIds) || trackIds.length > 10_000 || new Set(trackIds).size !== trackIds.length || !trackIds.every(dto.isCollectionId)) return access.conflict('整理元数据事实成员无效。');
      return access.read(db => {
        certificateFor(db);
        const selected = JSON.stringify(trackIds), probeStarted = performance.now();
        logLibraryOperation('library', 'workbench.provenance.phase', 'start', { code: 'OVERRIDE_PROBE', count: trackIds.length });
        const hasOverride = db.prepare('SELECT 1 FROM local_catalog_overrides WHERE track_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(selected);
        logLibraryOperation('library', 'workbench.provenance.phase', 'complete', { code: 'OVERRIDE_PROBE', elapsedMs: Math.max(0, performance.now() - probeStarted), count: hasOverride ? 1 : 0 });
        if (!hasOverride) {
          // 当前选中成员没有覆盖字段：仍逐个实核原track，只省去与这些成员无关的账本聚合。
          const tracksStarted = performance.now();
          const result = trackIds.map(trackId => { track(db, trackId); return { trackId, override: null }; });
          logLibraryOperation('library', 'workbench.provenance.phase', 'complete', { code: 'NO_CURRENT_OVERRIDE', elapsedMs: Math.max(0, performance.now() - tracksStarted), count: result.length });
          return result;
        }
        const ledgerStarted = performance.now();
        logLibraryOperation('library', 'workbench.provenance.phase', 'start', { code: 'OVERRIDE_LEDGER', count: trackIds.length });
        const rows = db.prepare(`WITH selected AS (SELECT value id FROM json_each(?)),latest AS (
          SELECT json_extract(result,'$.trackId') track_id,max(rowid) ordinal FROM local_catalog_ledger
          WHERE operation='override-metadata' AND json_extract(result,'$.trackId') IN (SELECT id FROM selected)
          GROUP BY json_extract(result,'$.trackId'))
          SELECT o.track_id,o.data,l.command_id,l.request,l.result FROM local_catalog_overrides o
          JOIN latest x ON x.track_id=o.track_id JOIN local_catalog_ledger l ON l.rowid=x.ordinal`).all(selected);
        logLibraryOperation('library', 'workbench.provenance.phase', 'complete', { code: 'OVERRIDE_LEDGER', elapsedMs: Math.max(0, performance.now() - ledgerStarted), count: rows.length });
        const byId = new Map<string, LocalWorkbenchMetadataProvenanceFact>();
        for (const row of rows) {
          boundedRow({ track_id: row.track_id, data: row.data });
          boundedRow({ command_id: row.command_id, request: row.request, result: row.result });
          const current = parse(row.data, dto.isLocalMetadataOverride), receipt = parse(row.result, dto.isLocalMetadataOverride);
          const request = parse(row.request, (value): value is Row & { commandId: string } => validRequest('override-metadata', value));
          if (row.track_id !== current.trackId || !dto.isCollectionId(row.command_id) || request.commandId !== row.command_id
            || request.trackId !== current.trackId || !same(current, receipt) || !same(request.fields, current.fields)) return corrupt();
          byId.set(current.trackId, { trackId: current.trackId, override: { commandId: String(row.command_id), revision: current.revision, fields: structuredClone(current.fields) } });
        }
        return trackIds.map(trackId => {
          track(db, trackId);
          const found = byId.get(trackId);
          if (!found && db.prepare('SELECT 1 FROM local_catalog_overrides WHERE track_id=?').get(trackId)) return corrupt();
          return found ?? { trackId, override: null };
        });
      });
    },
    privateAlbumBrowserQuery(request: dto.LocalAlbumQuery, scope: LocalAlbumSqlScope) {
      if (!dto.isLocalAlbumQuery(request)) return access.conflict('专辑分页读取范围无效。');
      return readWithLocalAlbumSqlErrors(access.read, db => {
        return albumReader(db, scope).queryAlbums(request);
      });
    },
    privateAlbumBrowserBackgroundCandidates(request: LocalAlbumBackgroundCandidateQuery, scope: LocalAlbumSqlScope) {
      if (!isLocalAlbumBackgroundCandidateQuery(request)) return access.conflict('后台封面候选分页范围无效。');
      return readWithLocalAlbumSqlErrors(access.read, db => albumReader(db, scope).queryBackgroundCandidates(request));
    },
    privateAlbumBrowserMembers(request: dto.LocalAlbumTrackQuery, scope: LocalAlbumSqlScope) {
      if (!dto.isLocalAlbumTrackQuery(request)) return access.conflict('专辑成员分页读取范围无效。');
      return readWithLocalAlbumSqlErrors(access.read, db => {
        return albumReader(db, scope).queryAlbumMembers(request);
      });
    },
    privateAlbumBrowserMobileStructure(request: import('./local-album-browser/sql-types.js').LocalAlbumSqlMobileQuery, scope: LocalAlbumSqlScope) {
      return access.read(db => {
        // 原完整核验与作者都属于本连接；不接受外来 WeakMap 句柄或库存作者。
        albumReader(db, scope)
        const author = albumSqlAuthors.get(db)
        if (!author) return corrupt()
        return createLocalAlbumMobileStructureSqlReader(db, author.source, author.codec, scope).queryMobile(request)
      })
    },
    privateAlbumBrowserSourceMember(request: import('./local-album-browser/source-member-identity.js').LocalAlbumSourceMemberRequest, scope: LocalAlbumSqlScope) {
      return readWithLocalAlbumSqlErrors(access.read, db => albumReader(db, scope).sourceMemberIdentity(request));
    },
    privateAlbumBrowserMobile(request: LocalAlbumSqlMobileQuery, scope: LocalAlbumSqlScope): LocalAlbumSqlMobilePage {
      return readWithLocalAlbumSqlErrors(access.read, db => {
        return albumReader(db, scope).queryMobile(request);
      });
    },
    privateAlbumBrowserArtwork(request: dto.LocalAlbumArtworkRequest, scope: LocalAlbumSqlScope) {
      if (!dto.isLocalAlbumArtworkRequest(request)) return access.conflict('专辑封面读取范围无效。');
      return readWithLocalAlbumSqlErrors(access.read, db => {
        return albumReader(db, scope).getArtworkContext(request);
      });
    },
    privateAlbumBrowserIssues(request: dto.LocalAlbumTrackQuery, scope: LocalAlbumSqlScope, readOptions?: LocalAlbumSqlIssueReadOptions) {
      if (!dto.isLocalAlbumTrackQuery(request)) return access.conflict('专辑问题分页读取范围无效。');
      return readWithLocalAlbumSqlErrors(access.read, db => {
        return albumReader(db, scope).queryAlbumIssues(request, readOptions);
      });
    },
    /** 只列原有逻辑曲目；不枚举文件系统，不改扫描历史，也不重签读取许可。 */
    privateArtistMetadataBackfillCandidates(after: number, limit: number): { items: ArtistMetadataBackfillCandidate[]; hasMore: boolean } {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return access.conflict('艺人补读分页范围无效。');
      return access.read(db => {
        certificateFor(db);
        const roots = db.prepare("SELECT id FROM local_catalog_roots WHERE json_extract(data,'$.role')='library' ORDER BY rowid").all()
          .map(row => String(row.id)).filter(rootId => libraryManagementRootAvailable(db, rootId));
        const rows = db.prepare(`SELECT t.rowid _artist_ordinal,t.* FROM local_catalog_tracks t
          JOIN local_catalog_assets a ON a.id=t.asset_id JOIN local_catalog_roots r ON r.id=a.root_id
          WHERE t.rowid>? AND r.id IN(SELECT value FROM json_each(?)) ORDER BY t.rowid LIMIT ?`).all(after, JSON.stringify(roots), limit + 1);
        return { items: rows.slice(0, limit).map(row => artistMetadataCandidate(db, row)), hasMore: rows.length > limit };
      });
    },
    privateCommitArtistMetadataBackfill(candidate: ArtistMetadataBackfillCandidate, fields: dto.LocalMetadata, parserVersion: string): void {
      if (!dto.isLocalMetadata(fields) || !dto.isLocalCatalogText(parserVersion) || !Object.hasOwn(fields, 'artists') || !Object.hasOwn(fields, 'albumArtists')) return access.conflict('艺人补读结果无效。');
      access.read(db => {
        const row = db.prepare('SELECT rowid _artist_ordinal,* FROM local_catalog_tracks WHERE id=?').get(candidate.track.id);
        if (!row) return access.conflict('艺人补读对应曲目已变化。');
        const current = artistMetadataCandidate(db, row), root = readRoot(one(db, 'local_catalog_roots', current.asset.libraryRootId));
        if (!same(current.track, candidate.track) || !same(current.asset, candidate.asset) || current.relative !== candidate.relative
          || !current.signature || current.signature !== candidate.signature || current.scanJobId !== candidate.scanJobId
          || root.role !== 'library' || !libraryManagementRootAvailable(db, root.id)
          || root.revision !== current.asset.rootRevision || root.sourceRootId !== current.asset.sourceRootId
          || !access.sources.root(root.sourceRootId).authorized) return access.conflict('艺人补读期间来源或曲目已变化。');
        if (current.complete) return;
        // CUE片段的歌曲艺人来自原片段观察；文件标签只补专辑艺人，不用整轨artist覆盖片段performer。
        const original = candidate.track.segment ? libraryMetadata(db, candidate.track.id).raw : null;
        const artists = original ? original.artists ?? (original.artist?.trim() ? [original.artist] : []) : fields.artists!;
        const request: ObserveLocalMetadata = { commandId: randomUUID(), trackId: candidate.track.id, source: 'tag', parserVersion,
          fields: { artists: [...artists], albumArtists: [...fields.albumArtists!], albumArtist: fields.albumArtist ?? '' } };
        transaction('observe-metadata', request, inner => applyObserveMetadata(inner, request));
      });
    },
    /** 派生艺人索引只读原账本尾部；未知写入与结构变化必须回原分组重建。 */
    privateArtistSearchChanges(after: number): { highWater: number; rebuild: boolean; trackIds: string[] } {
      if (!Number.isSafeInteger(after) || after < 0) return access.conflict('艺人索引水位无效。');
      return access.read(db => {
        certificateFor(db);
        const highWater = Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n);
        const rows = db.prepare('SELECT rowid,operation,request,result FROM local_catalog_ledger WHERE rowid>? ORDER BY rowid LIMIT 10001').all(after);
        if (after > highWater || rows.length > 10000) return { highWater, rebuild: true, trackIds: [] };
        const trackIds = new Set<string>(); let rebuild = false;
        for (const row of rows) {
          boundedRow(row);
          const result = JSON.parse(String(row.result)) as Row, request = JSON.parse(String(row.request)) as Row;
          if (row.operation === 'observe-metadata' || row.operation === 'override-metadata') {
            if (!dto.isCollectionId(result.trackId) || !dto.isLocalMetadata(request.fields)) return corrupt();
            // album/disc会改变原目录归属；未知journal也不能靠局部猜测更新。
            if (Object.hasOwn(request.fields, 'album') || Object.hasOwn(request.fields, 'disc')) rebuild = true;
            trackIds.add(result.trackId);
          } else if (row.operation === 'create-track' || row.operation === 'select-asset') {
            if (!dto.isCollectionId(result.id)) return corrupt(); trackIds.add(result.id);
            rebuild = true;
          } else rebuild = true;
        }
        return { highWater, rebuild, trackIds: [...trackIds] };
      });
    },
    queryTracks(page: dto.LocalLibraryQuery): dto.LocalLibraryQueryPage {
      if (!dto.isLocalLibraryQuery(page)) return access.conflict('本地搜索或分页范围无效。');
      return access.read(db => {
        const projection=sourceProjectionFor(db),sourceRaw=JSON.stringify([...projection.fullRaw].map(([trackId,value])=>({trackId,ordinal:value.ledgerOrdinal,fields:value.fields})));
        const filters = { root: page.rootId, query: page.query.trim(),sourceRaw };
        const total = Number(db.prepare(`${libraryProjection} SELECT count(*) n FROM candidates WHERE ${libraryWhere}`).get(filters)!.n);
        const rows = db.prepare(`${libraryProjection} SELECT * FROM candidates WHERE ${libraryWhere} ORDER BY ordinal LIMIT @limit OFFSET @offset`).all({ ...filters, limit: page.limit, offset: page.offset });
        const items = rows.map(row => {
          boundedRow(row);
          const raw = readProjectedLocalMetadata(row, 'raw'), metadata = readProjectedLocalMetadata(row, 'effective');
          return { track: readTrack(row), asset: readAsset({ id: row.asset_record_id, root_id: row.root_id, source_root_id: row.source_root_id, relative: row.relative, sha256: row.sha256, data: row.asset_data }), metadata, versionTokens: libraryVersionTokens(raw) };
        });
        const result = { ...page, total, hasMore: page.offset + items.length < total, items };
        if (!dto.isLocalLibraryQueryPage(result)) return corrupt();
        return result;
      });
    },
    /** 移动只读候选复用原 effective/raw 投影；不增公开命令，不新开连接。 */
    privateMobileCandidates(page: { kind: 'albums' | 'tracks'; offset: number; limit: number; query: string; editionId: string | null; trackId: string | null }): { total: number; items: { editionId: string; trackId: string }[] } {
      if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100
        || typeof page.query !== 'string' || [...page.query].length > 200 || page.editionId !== null && !dto.isCollectionId(page.editionId)
        || page.trackId !== null && !dto.isCollectionId(page.trackId)) return access.conflict('移动目录分页范围无效。');
      return access.read(db => {
        const projection = sourceProjectionFor(db), sourceRaw = JSON.stringify([...projection.fullRaw].map(([trackId, value]) => ({ trackId, ordinal: value.ledgerOrdinal, fields: value.fields })));
        const filters = { root: null, query: page.query.trim(), sourceRaw, edition: page.editionId, track: page.trackId };
        if (page.kind === 'tracks' && page.editionId === null) {
          const orphan = db.prepare(`${libraryProjection} SELECT 1 missing FROM candidates
            JOIN local_catalog_roots r ON r.id=candidates.root_id JOIN source_roots s ON s.id=r.source_root_id
            WHERE json_extract(r.data,'$.role')='library' AND json_extract(s.data,'$.authorized')=1 AND ${libraryWhere}
            AND NOT EXISTS(SELECT 1 FROM local_catalog_edition_tracks l WHERE l.track_id=candidates.id AND json_extract(l.data,'$.active')=1) LIMIT 1`).get({ root: null, query: filters.query, sourceRaw });
          if (orphan) throw new MobileServiceError(503, 'BUSY');
        }
        const relations = `${libraryProjection}, mobile AS (SELECT candidates.ordinal,candidates.id track_id,e.id edition_id,e.rowid edition_ordinal,
          json_extract(l.data,'$.sequence') sequence FROM candidates
          JOIN local_catalog_edition_tracks l ON l.track_id=candidates.id AND json_extract(l.data,'$.active')=1
          JOIN local_catalog_editions e ON e.id=l.edition_id JOIN local_catalog_roots r ON r.id=candidates.root_id
          JOIN source_roots s ON s.id=r.source_root_id
          WHERE json_extract(r.data,'$.role')='library' AND json_extract(s.data,'$.authorized')=1
          AND (@edition IS NULL OR e.id=@edition) AND (@track IS NULL OR candidates.id=@track) AND ${libraryWhere})`;
        const candidates = page.kind === 'albums'
          ? `${relations}, selected AS (SELECT edition_id,min(track_id) track_id,min(edition_ordinal) ordinal FROM mobile GROUP BY edition_id)`
          : `${relations}, selected AS (SELECT edition_id,track_id,min(ordinal) ordinal,min(sequence) sequence FROM mobile GROUP BY edition_id,track_id)`;
        const total = Number(db.prepare(`${candidates} SELECT count(*) n FROM selected`).get(filters)!.n);
        if (total > 300_000) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
        const order = page.kind === 'albums' ? 'ordinal,edition_id' : 'ordinal,edition_id,sequence,track_id';
        const rows = db.prepare(`${candidates} SELECT edition_id,track_id FROM selected ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({ ...filters, limit: page.limit, offset: page.offset });
        return { total, items: rows.map(row => ({ editionId: String(row.edition_id), trackId: String(row.track_id) })) };
      });
    },
    trackDetail(trackId: string): dto.LocalLibraryTrackDetail {
      id(trackId); return access.read(db => {
        sourceProjectionFor(db);
        const selected = track(db, trackId), asset = readAsset(one(db, 'local_catalog_assets', selected.assetId));
        const metadata = libraryMetadata(db, trackId);
        const rows = db.prepare("SELECT DISTINCT e.data FROM local_catalog_edition_tracks l JOIN local_catalog_editions e ON e.id=l.edition_id WHERE l.track_id=? AND json_extract(l.data,'$.active')=1 ORDER BY e.rowid LIMIT 201").all(trackId);
        if (rows.length > maxCatalogReadRows) throw new LocalCatalogBudgetError('详情发行关系读取行数', rows.length, maxCatalogReadRows);
        const result = { track: selected, asset, metadata, versionTokens: libraryVersionTokens(metadata.raw), editions: rows.map(row => parse(row.data, dto.isAlbumEdition)), fileParameters: null };
        if (!dto.isLocalLibraryTrackDetail(result)) return corrupt();
        return result;
      });
    },
    createEdition(request: CreateAlbumEdition): dto.AlbumEdition { return transaction('create-edition', request, db => applyCreateEdition(db, request)); },
    edition(editionId: string): dto.AlbumEdition { id(editionId); return access.read(db => parse(one(db, 'local_catalog_editions', editionId).data, dto.isAlbumEdition)); },
    linkEditionTrack(request: LinkEditionTrack): dto.AlbumEditionTrack { return transaction('link-edition-track', request, db => applyLinkEditionTrack(db, request)); },
    removeEditionTrack(request: RemoveEditionTrack): dto.AlbumEditionTrack { return transaction('remove-edition-track', request, db => applyRemoveEditionTrack(db, request)); },
    privateQueueEditionTracks(editionId: string): dto.AlbumEditionTrack[] {
      id(editionId);return access.read(db=>{
        one(db,'local_catalog_editions',editionId);
        const rows=db.prepare("SELECT data FROM local_catalog_edition_tracks WHERE edition_id=? AND json_extract(data,'$.active')=1 ORDER BY json_extract(data,'$.disc'),json_extract(data,'$.trackNumber'),json_extract(data,'$.sequence'),id LIMIT 5001").all(editionId);
        if(rows.length>5000)throw new LocalCatalogBudgetError('发行版队列容量',rows.length,5000);
        return rows.map(row=>parse(row.data,dto.isAlbumEditionTrack));
      });
    },
    editionTracks(editionId: string): dto.AlbumEditionTrack[] {
      id(editionId); return access.read(db => {
        one(db, 'local_catalog_editions', editionId);
        const rows = db.prepare('SELECT data FROM local_catalog_edition_tracks WHERE edition_id=? ORDER BY rowid LIMIT 201').all(editionId);
        if (rows.length > maxCatalogReadRows) throw new LocalCatalogBudgetError('发行版曲目单次读取行数', rows.length, maxCatalogReadRows);
        return rows.map(row => parse(row.data, dto.isAlbumEditionTrack));
      });
    },
    observeMetadata(request: ObserveLocalMetadata): dto.LocalMetadataObservation { return transaction('observe-metadata', request, db => applyObserveMetadata(db, request)); },
    overrideMetadata(request: OverrideLocalMetadata): dto.LocalMetadataOverride { return transaction('override-metadata', request, db => applyOverrideMetadata(db, request)); },
    observations(trackId: string): dto.LocalMetadataObservation[] {
      id(trackId); return access.read(db => {
        track(db, trackId);
        const rows = db.prepare('SELECT data FROM local_catalog_observations WHERE track_id=? ORDER BY rowid LIMIT 201').all(trackId);
        if (rows.length > maxCatalogReadRows) throw new LocalCatalogBudgetError('raw元数据单次读取行数', rows.length, maxCatalogReadRows);
        return rows.map(row => parse(row.data, dto.isLocalMetadataObservation));
      });
    },
    metadata(trackId: string): { raw: dto.LocalMetadata; override: dto.LocalMetadataOverride | null; effective: dto.LocalMetadata } {
      id(trackId); return access.read(db => {
        track(db, trackId);sourceProjectionFor(db);return libraryMetadata(db,trackId);
      });
    },
    privateReceiptRequest(commandId: string): { operation: dto.LocalCatalogOperation; request: Record<string,unknown>; result: dto.LocalCatalogResult } | null {
      id(commandId);return access.read(db=>{
        const row=db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(commandId);if(!row)return null;boundedRow(row);
        const operation=row.operation;if(typeof operation!=='string'||!(dto.LOCAL_CATALOG_OPERATIONS as readonly string[]).includes(operation))return corrupt();
        const typedOperation=operation as dto.LocalCatalogOperation;
        const request:unknown=JSON.parse(String(row.request)),result:unknown=JSON.parse(String(row.result));
        const receipt={commandId,operation:typedOperation,fingerprint:row.fingerprint,result};
        if(!validRequest(typedOperation,request)||!dto.isLocalCatalogReceipt(receipt)||row.fingerprint!==fingerprint(typedOperation,request))return corrupt();
        return {operation:typedOperation,request:{...request},result:receipt.result};
      });
    },
    privateAssetHasExactEvidence(assetId: string): boolean {
      id(assetId);return access.read(db=>!!db.prepare("SELECT id FROM local_catalog_assets WHERE id=? AND (sha256 IS NOT NULL OR json_extract(data,'$.sampleFrames') IS NOT NULL OR json_extract(data,'$.timebaseHz') IS NOT NULL) LIMIT 1").get(assetId));
    },
    privateRootHasExactAssets(rootId: string): boolean {
      id(rootId);return access.read(db=>!!db.prepare("SELECT id FROM local_catalog_assets WHERE root_id=? AND (sha256 IS NOT NULL OR json_extract(data,'$.sampleFrames') IS NOT NULL OR json_extract(data,'$.timebaseHz') IS NOT NULL) LIMIT 1").get(rootId));
    },
    receipt(commandId: string): dto.LocalCatalogReceipt | null {
      id(commandId); return access.read(db => {
        const row = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(commandId); if (!row) return null;
        const value: unknown = { commandId: row.command_id, operation: row.operation, fingerprint: row.fingerprint, result: JSON.parse(String(row.result)) };
        return dto.isLocalCatalogReceipt(value) ? value : corrupt();
      });
    },
  };
  mbOnlyCatalogOwners.set(result,assertWorkbenchIdentity);return result;
}
export type LocalCatalogStore = ReturnType<typeof createLocalCatalogStore>;
