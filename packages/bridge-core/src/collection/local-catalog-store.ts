import { commitLocalFacts, rollbackLocalFacts, LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { createHash, randomUUID } from 'node:crypto';
import { MobileServiceError } from '../mobile/types.js';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import type { SourceStore } from '../recording/source-store.js';
import type { RootCapability } from '../recording/source-files.js';
import { extractVersionTokens } from '../library/local-name-rules.js';
import { ORGANIZER_JOURNAL, isOrganizerEvent, organizerHash, organizerCanonical, readOrganizerEvent, verifyOrganizerJournalRow, type OrganizerEvent } from './local-organizer-journal.js';
import { LOCAL_LEGACY_LINKS_OPERATION, LegacyLinksError, legacyLinksFail, emptyLegacyLinksProjection, copyLegacyLinksProjection, readLegacyLinksEvent, projectLegacyLinksEvent, verifyLegacyLinksLocalSnapshot, legacyLinksSlot, type LegacyLinksProjection, type LegacyLinksView, type LegacyLinksWriteView, type LegacyLinksEvent, isLegacyLinksEvent } from './local-legacy-links-journal.js';
import { SOURCE_WRITES_OPERATION, sourceWritesFail, emptySourceWritesProjection, copySourceWritesProjection, readSourceWritesEvent, projectSourceWritesEvent, sourceWritesLedgerRow, type SourceWritesProjection, type SourceWritesReadView, type SourceWritesWriteView, type SourceWritesEvent } from './local-source-writes-journal.js';
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
const legacyAudits = new WeakMap<DatabaseSync, LegacyLinksProjection | 'BUDGET_EXCEEDED'>();
const sourceWritesAudits=new WeakMap<DatabaseSync,SourceWritesProjection>();
const relocationAudits = new WeakMap<DatabaseSync, RelocationProjection>();
/** 只供原扫描冷核/参数证据；不签grant、不暴露数据库给服务。 */
export function sourceWritesProjectionForDatabase(db:DatabaseSync):SourceWritesProjection|undefined{return sourceWritesAudits.get(db);}
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
  return { raw, override, effective: { ...raw, ...override?.fields } };
}
function libraryVersionTokens(fields: dto.LocalMetadata): dto.VersionNameToken[] {
  return (['title', 'artist', 'album'] as const).flatMap(source => fields[source] ? extractVersionTokens(fields[source]!, source) : []).slice(0, 64);
}
const libraryFields = ['title', 'artist', 'album', 'year', 'disc', 'track'] as const;
// 每个字段按原观察历史的最后一次存在值读取；部分标签观察不会抹掉未提供字段。
const libraryRaw = (field: string) => `COALESCE((SELECT json_extract(o.data,'$.fields.${field}') FROM local_catalog_observations o WHERE o.track_id=t.id AND json_type(o.data,'$.fields.${field}') IS NOT NULL AND (sf.ordinal IS NULL OR EXISTS(SELECT 1 FROM local_catalog_ledger l WHERE l.rowid>sf.ordinal AND l.operation='observe-metadata' AND json_extract(l.result,'$.id')=o.id)) ORDER BY o.rowid DESC LIMIT 1),json_extract(sf.fields,'$.${field}'))`;
const libraryProjection = `WITH source_full AS (SELECT CAST(json_extract(value,'$.trackId') AS TEXT) track_id,CAST(json_extract(value,'$.ordinal') AS INTEGER) ordinal,json_extract(value,'$.fields') fields FROM json_each(@sourceRaw)),candidates AS (SELECT t.rowid ordinal,t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,
  ${libraryFields.flatMap(field => [`${libraryRaw(field)} raw_${field}`, `COALESCE(json_extract(v.data,'$.fields.${field}'),${libraryRaw(field)}) effective_${field}`]).join(',')}
  FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE (@root IS NULL OR a.root_id=@root))`;
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
  latest: Map<string, dto.LocalCatalogResult>, privateAssets: Map<string, { relative: unknown; sha256: unknown }>, observations: Map<string, string>, relations?: HistoryRelations): void {
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
        for (const selected of relations.tracks.get(old.id)?.values() ?? []) checkSegment(selected, result as dto.AudioAsset);
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
export function verifyLocalCatalogDatabase(db: DatabaseSync): void {
  audits.delete(db);
  legacyAudits.delete(db);
  sourceWritesAudits.delete(db);
  relocationAudits.delete(db);
  const initialDataVersion = dataVersion(db);
  for (const [name, sql] of Object.entries(tables)) if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for (const [type, statements] of [['index', indexes], ['trigger', triggers]] as const) for (const sql of statements) {
    const name = sql.split(' ')[type === 'index' && sql.startsWith('CREATE UNIQUE') ? 3 : 2]!;
    if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, name)?.sql !== sql) return corrupt();
  }
  let bytes = 0;
  const counts = new Map<Table, number>();
  for (const table of Object.keys(tables) as Table[]) {
    const textColumns = db.prepare(`PRAGMA table_info(${table})`).all().filter(c => c.type === 'TEXT').map(c => String(c.name));
    const rowTextSize = textColumns.map(c => `COALESCE(length(CAST(${c} AS BLOB)),0)`).join('+');
    const size = db.prepare(`SELECT count(*) n,COALESCE(sum(${rowTextSize}),0) bytes,COALESCE(max(${rowTextSize}),0) largest FROM ${table}`).get()!;
    if (Number(size.largest) > maxRowTextBytes) return corrupt();
    const count = Number(size.n); checkBudget(`${table}行数`, count, rowBudgets[table]); counts.set(table, count); bytes += Number(size.bytes);
  }
  checkBudget('目录总文本字节', bytes, maxCatalogTextBytes);
  const latest = new Map<string, dto.LocalCatalogResult>();
  const privateAssets = new Map<string, { relative: unknown; sha256: unknown }>();
  const observations = new Map<string, string>();
  const relations: HistoryRelations = { tracks: new Map(), editionSequences: new Map() };
  let immutableObservations = 0;
  let legacy: LegacyLinksProjection | 'BUDGET_EXCEEDED' = emptyLegacyLinksProjection();
  const sourceWrites=emptySourceWritesProjection();
  const relocation = emptyRelocationProjection();
  const rootFactsObligations = new Map<string, { before: dto.LibraryRoot; after: dto.LibraryRoot;
    pending: Map<string, { operationId: string; resourceId: string }> }>();
  for (const row of db.prepare('SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger ORDER BY rowid').iterate()) {
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
        for (const value of latest.values()) if (dto.isAudioAsset(value) && value.libraryRootId === event.beforeRoot.id) {
          members.add(value.id); if (members.size > dto.LOCAL_RELOCATION_PLAN_BUDGET.operations) return corrupt();
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
        for (const track of fact.tracks) checkSegment(track, fact.afterAsset);
        latest.set(`local_catalog_assets:${fact.afterAsset.id}`, fact.afterAsset);
        privateAssets.set(fact.afterAsset.id, { relative: fact.target.relative, sha256: fact.catalogSha256 });
        rootObligation?.pending.delete(fact.beforeAsset.id);
      }
      projectRelocationEvent(relocation, event, ledgerRowId); continue;
    }
    if(row.operation===SOURCE_WRITES_OPERATION){
      const event=readSourceWritesEvent(row);
      if(event.kind==='facts'){
        const fact=event.fact,child=db.prepare("SELECT result,request FROM local_catalog_ledger WHERE command_id=? AND operation='replace-asset'").get(fact.replaceCommandId);
        if(!child||!same(JSON.parse(String(child.result)),fact.afterAsset)||!same(latest.get(`local_catalog_assets:${fact.afterAsset.id}`),fact.afterAsset))return corrupt();
        const request=JSON.parse(String(child.request)) as Row;if(request.sha256!==fact.observation.sha256||request.expectedFileRevision!==fact.beforeAsset.fileRevision)return corrupt();
        for(const id of fact.affectedTrackIds){const t=latest.get(`local_catalog_tracks:${id}`);if(!dto.isLocalTrack(t)||t.assetId!==fact.afterAsset.id||t.segment!==null)return corrupt();}
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
    if (row.operation === ORGANIZER_JOURNAL) { verifyOrganizerJournalRow(db, row, latest); continue; }
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
    verifyHistoryStep(db, operation, request, result, latest, privateAssets, observations, relations);
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
      const stored = db.prepare('SELECT * FROM local_catalog_observations WHERE id=?').get(id);
      if (!stored || stored.id !== id || stored.track_id !== (result as dto.LocalMetadataObservation).trackId
        || !same(parse(stored.data, dto.isLocalMetadataObservation), result)) return corrupt();
      boundedRow(stored); immutableObservations++;
    } else latest.set(key, result);
  }
  // 同一根CAS的全成员位置事实必须齐全；完整READY声明和旧rootRevision不能掩盖部分账本。
  for (const obligation of rootFactsObligations.values()) if (obligation.pending.size) return corrupt();
  let entities = 0;
  for (const table of Object.keys(tables).filter(name => name !== 'local_catalog_ledger') as Exclude<Table, 'local_catalog_ledger'>[]) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
      const id = String(table === 'local_catalog_overrides' ? row.track_id : row.id);
      boundedRow(row);
      const stored = latest.get(`${table}:${id}`);
      if (table !== 'local_catalog_observations' && (!stored || !same(JSON.parse(String(row.data)), stored))) return corrupt();
      if (table === 'local_catalog_roots') readRoot(row);
      if (table === 'local_catalog_assets') {
        const asset = readAsset(row), root = db.prepare('SELECT * FROM local_catalog_roots WHERE id=?').get(asset.libraryRootId);
        if (!root || BigInt(asset.rootRevision) > BigInt(readRoot(root).revision) || !same(privateAssets.get(id), { relative: row.relative, sha256: row.sha256 })) return corrupt();
      }
      if (table === 'local_catalog_tracks') {
        const track = readTrack(row), asset = db.prepare('SELECT * FROM local_catalog_assets WHERE id=?').get(track.assetId);
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
  if (immutableObservations !== counts.get('local_catalog_observations') || entities !== latest.size + immutableObservations || db.prepare('PRAGMA foreign_key_check').get()
    || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') return corrupt();
  if (dataVersion(db) !== initialDataVersion) return corrupt();
  audits.set(db, { rows: counts, bytes, dataVersion: initialDataVersion });
  legacyAudits.set(db,legacy);
  sourceWrites.highWater=Math.max(sourceWrites.highWater,Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n));sourceWritesAudits.set(db,sourceWrites);
  relocation.highWater = Math.max(relocation.highWater, Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM local_catalog_ledger').get()!.n));
  relocationAudits.set(db, relocation);
}

export function createLocalCatalogStore(access: Access) {
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
    const value = root(db, id); if (value.revision !== revision) return access.conflict('本地目录关联修订已改变。'); authorized(value.sourceRootId); return value;
  };
  function overlap(db: DatabaseSync, source: RootCapability, except?: string): void {
    for (const row of db.prepare('SELECT * FROM local_catalog_roots').all()) {
      const value = readRoot(row); if (value.id === except) continue;
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
      try {
        const candidate = mutate(db, certificateFor(db), operation, request, apply);
        if (candidate.changed) {
          access.beforeCommit?.(`local-catalog:${operation}`);
          if (Number(db.prepare('SELECT total_changes() n').get()?.n) !== candidate.beforeChanges + 2) return corrupt();
        }
        access.beforeLocalFactsCommit?.();
        commitLocalFacts(db,access.onLocalFactsFatal); audits.set(db, candidate.certificate); return candidate.result;
      } catch (error) { rollbackLocalFacts(db,error,access.onLocalFactsFatal); }
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
        const source = authorized(request.sourceRootId); overlap(db, source);
        const result: dto.LibraryRoot = { id: randomUUID(), sourceRootId: source.id, role: request.role, revision: '1' };
        db.prepare('INSERT INTO local_catalog_roots VALUES(?,?,?)').run(result.id, source.id, JSON.stringify(result)); return result;
  }
  function applyRelinkRoot(db: DatabaseSync, request: RelinkLibraryRoot): dto.LibraryRoot {
        const old = root(db, request.rootId); if (old.revision !== request.expectedRevision) return access.conflict('本地目录关联修订已改变。');
        const source = authorized(request.sourceRootId); overlap(db, source, old.id);
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
  return {
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
    privateBatch<T>(operation: (db: DatabaseSync, mutate: (name: dto.LocalCatalogOperation, request: Command & Row) => dto.LocalCatalogResult, appendJournal: (event: OrganizerEvent) => void) => T, action = 'local-scan:commit-batch'): T {
      return access.read(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          let certificate = certificateFor(db);
          let expectedChanges = Number(db.prepare('SELECT total_changes() n').get()?.n);
          const journalRows: Row[] = [];
          const applyMutation = (name: dto.LocalCatalogOperation, request: Command & Row): dto.LocalCatalogResult => {
            const operation = name;
            if (!validRequest(operation, request)) return access.conflict('本地目录私有批请求无效。');
            switch (operation) {
              case 'register-root': { const candidate = mutate(db, certificate, operation, request, d => applyRegisterRoot(d, request as unknown as RegisterLibraryRoot)); certificate = candidate.certificate; return candidate.result; }
              case 'relink-root': { const candidate = mutate(db, certificate, operation, request, d => applyRelinkRoot(d, request as unknown as RelinkLibraryRoot)); certificate = candidate.certificate; return candidate.result; }
              case 'register-asset': { const candidate = mutate(db, certificate, operation, request, d => applyRegisterAsset(d, request as unknown as RegisterAudioAsset)); certificate = candidate.certificate; return candidate.result; }
              case 'move-asset': { const candidate = mutate(db, certificate, operation, request, d => applyMoveAsset(d, request as unknown as MoveAudioAsset)); certificate = candidate.certificate; return candidate.result; }
              case 'replace-asset': { const candidate = mutate(db, certificate, operation, request, d => applyReplaceAsset(d, request as unknown as ReplaceAudioAsset)); certificate = candidate.certificate; return candidate.result; }
              case 'create-track': { const candidate = mutate(db, certificate, operation, request, d => applyCreateTrack(d, request as unknown as CreateLocalTrack)); certificate = candidate.certificate; return candidate.result; }
              case 'select-asset': { const candidate = mutate(db, certificate, operation, request, d => applySelectAsset(d, request as unknown as SelectLocalAsset)); certificate = candidate.certificate; return candidate.result; }
              case 'create-edition': { const candidate = mutate(db, certificate, operation, request, d => applyCreateEdition(d, request as unknown as CreateAlbumEdition)); certificate = candidate.certificate; return candidate.result; }
              case 'link-edition-track': { const candidate = mutate(db, certificate, operation, request, d => applyLinkEditionTrack(d, request as unknown as LinkEditionTrack)); certificate = candidate.certificate; return candidate.result; }
              case 'remove-edition-track': { const candidate = mutate(db, certificate, operation, request, d => applyRemoveEditionTrack(d, request as unknown as RemoveEditionTrack)); certificate = candidate.certificate; return candidate.result; }
              case 'observe-metadata': { const candidate = mutate(db, certificate, operation, request, d => applyObserveMetadata(d, request as unknown as ObserveLocalMetadata)); certificate = candidate.certificate; return candidate.result; }
              case 'override-metadata': { const candidate = mutate(db, certificate, operation, request, d => applyOverrideMetadata(d, request as unknown as OverrideLocalMetadata)); certificate = candidate.certificate; return candidate.result; }
            }
          };
          const apply = (name: dto.LocalCatalogOperation, request: Command & Row): dto.LocalCatalogResult => {
            const before = Number(db.prepare('SELECT total_changes() n').get()?.n), result = applyMutation(name, request);
            expectedChanges += Number(db.prepare('SELECT total_changes() n').get()?.n) - before; return result;
          };
          const appendJournal = (event: OrganizerEvent): void => {
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
          commitLocalFacts(db,access.onLocalFactsFatal); audits.set(db, certificate); return result;
        } catch (error) { rollbackLocalFacts(db,error,access.onLocalFactsFatal); }
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
    queryTracks(page: dto.LocalLibraryQuery): dto.LocalLibraryQueryPage {
      if (!dto.isLocalLibraryQuery(page)) return access.conflict('本地搜索或分页范围无效。');
      return access.read(db => {
        const projection=sourceProjectionFor(db),sourceRaw=JSON.stringify([...projection.fullRaw].map(([trackId,value])=>({trackId,ordinal:value.ledgerOrdinal,fields:value.fields})));
        const filters = { root: page.rootId, query: page.query.trim(),sourceRaw };
        const total = Number(db.prepare(`${libraryProjection} SELECT count(*) n FROM candidates WHERE ${libraryWhere}`).get(filters)!.n);
        const rows = db.prepare(`${libraryProjection} SELECT * FROM candidates WHERE ${libraryWhere} ORDER BY ordinal LIMIT @limit OFFSET @offset`).all({ ...filters, limit: page.limit, offset: page.offset });
        const items = rows.map(row => {
          boundedRow(row);
          const raw: dto.LocalMetadata = {}, metadata: dto.LocalMetadata = {};
          for (const field of libraryFields) {
            if (typeof row[`raw_${field}`] === 'string') raw[field] = row[`raw_${field}`] as string;
            if (typeof row[`effective_${field}`] === 'string') metadata[field] = row[`effective_${field}`] as string;
          }
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
}
export type LocalCatalogStore = ReturnType<typeof createLocalCatalogStore>;
