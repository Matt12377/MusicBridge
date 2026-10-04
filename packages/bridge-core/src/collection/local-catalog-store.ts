import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import type { SourceStore } from '../recording/source-store.js';
import type { RootCapability } from '../recording/source-files.js';

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
export interface OverrideLocalMetadata extends Command { trackId: string; expectedRevision: string | null; fields: dto.LocalMetadata }
interface Access { read<T>(operation: (db: DatabaseSync) => T): T; sources: Pick<SourceStore, 'root'>; conflict(message: string): never; beforeCommit?: (action: string) => void }
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
    case 'override-metadata': return keys(v, ['commandId', 'trackId', 'expectedRevision', 'fields']) && dto.isCollectionId(v.trackId) && (v.expectedRevision === null || dto.isLocalCatalogRevision(v.expectedRevision)) && dto.isLocalMetadata(v.fields);
  }
}
function parse<T>(value: unknown, guard: (v: unknown) => v is T): T {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536) return corrupt();
  const result: unknown = JSON.parse(value); return guard(result) ? result : corrupt();
}
const readRoot = (row: Row): dto.LibraryRoot => { const result = parse(row.data, dto.isLibraryRoot); if (row.id !== result.id || row.source_root_id !== result.sourceRootId) return corrupt(); return result; };
const readAsset = (row: Row): dto.AudioAsset => { const result = parse(row.data, dto.isAudioAsset); if (row.id !== result.id || row.root_id !== result.libraryRootId || row.source_root_id !== result.sourceRootId || !relativePath(row.relative) || !sha(row.sha256)) return corrupt(); return result; };
const readTrack = (row: Row): dto.LocalTrack => { const result = parse(row.data, dto.isLocalTrack); if (row.id !== result.id || row.asset_id !== result.assetId) return corrupt(); return result; };
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
      equal({ trackId: selected.id, revision: previous ? next(previous.revision) : '1', fields: request.fields }); break;
    }
  }
}

/** 同连接/只读备份均核真实DDL、关系、私有位置和全部回执；不打开第二写连接。 */
export function verifyLocalCatalogDatabase(db: DatabaseSync): void {
  audits.delete(db);
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
  for (const row of db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').iterate()) {
    boundedRow(row);
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
  function transaction<T extends dto.LocalCatalogResult>(operation: dto.LocalCatalogOperation, request: Command, apply: (db: DatabaseSync) => T): T {
    if (!validRequest(operation, request)) return access.conflict('本地目录请求无效。');
    return access.read(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const certificate = audits.get(db);
        // 单作者连接以外的提交使凭证失效；拒热写，重新冷开才允许完整核验并建立新凭证。
        if (!certificate || dataVersion(db) !== certificate.dataVersion || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
          throw new Error('工作库完整核验凭证或写入约束已改变，请关闭并重新冷开核验；现有数据保留。');
        }
        const digest = fingerprint(operation, request), previous = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(request.commandId);
        if (previous) {
          if (previous.fingerprint !== digest || previous.operation !== operation) return access.conflict('同一操作编号不能用于不同本地目录请求。');
          const result = verifyReceipt(previous, operation, request) as T; db.exec('COMMIT'); return result;
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
        access.beforeCommit?.(`local-catalog:${operation}`);
        if (Number(db.prepare('SELECT total_changes() n').get()?.n) !== beforeChanges + 2) return corrupt();
        db.exec('COMMIT'); audits.set(db, { rows: counts, bytes, dataVersion: certificate.dataVersion }); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  const id = (value: string): void => { if (!dto.isCollectionId(value)) access.conflict('本地对象身份无效。'); };
  const checkTrackSegment = (value: dto.LocalTrack, selected: dto.AudioAsset): void => { try { checkSegment(value, selected); } catch { access.conflict('片段时间基或范围与所选资产不一致。'); } };
  return {
    registerRoot(request: RegisterLibraryRoot): dto.LibraryRoot {
      return transaction('register-root', request, db => {
        const source = authorized(request.sourceRootId); overlap(db, source);
        const result: dto.LibraryRoot = { id: randomUUID(), sourceRootId: source.id, role: request.role, revision: '1' };
        db.prepare('INSERT INTO local_catalog_roots VALUES(?,?,?)').run(result.id, source.id, JSON.stringify(result)); return result;
      });
    },
    relinkRoot(request: RelinkLibraryRoot): dto.LibraryRoot {
      return transaction('relink-root', request, db => {
        const old = root(db, request.rootId); if (old.revision !== request.expectedRevision) return access.conflict('本地目录关联修订已改变。');
        const source = authorized(request.sourceRootId); overlap(db, source, old.id);
        const result = { ...old, sourceRootId: source.id, role: request.role, revision: next(old.revision) };
        db.prepare('UPDATE local_catalog_roots SET source_root_id=?,data=? WHERE id=?').run(source.id, JSON.stringify(result), old.id); return result;
      });
    },
    root(rootId: string): dto.LibraryRoot { id(rootId); return access.read(db => root(db, rootId)); },
    roots(): dto.LibraryRoot[] { return access.read(db => db.prepare('SELECT * FROM local_catalog_roots ORDER BY rowid').all().map(readRoot)); },
    registerAsset(request: RegisterAudioAsset): dto.AudioAsset {
      return transaction('register-asset', request, db => {
        const selected = currentRoot(db, request.libraryRootId, request.expectedRootRevision);
        const result: dto.AudioAsset = { id: randomUUID(), libraryRootId: selected.id, sourceRootId: selected.sourceRootId, rootRevision: selected.revision, fileRevision: '1', locationRevision: '1', sampleFrames: request.sampleFrames, timebaseHz: request.timebaseHz };
        db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(result.id, selected.id, selected.sourceRootId, request.relative, request.sha256, JSON.stringify(result)); return result;
      });
    },
    moveAsset(request: MoveAudioAsset): dto.AudioAsset {
      return transaction('move-asset', request, db => {
        const old = asset(db, request.assetId), selected = currentRoot(db, old.libraryRootId, request.expectedRootRevision);
        if (old.locationRevision !== request.expectedLocationRevision || old.sourceRootId !== selected.sourceRootId) return access.conflict('位置或根关联已改变，需要新的资产观察。');
        const result = { ...old, rootRevision: selected.revision, locationRevision: next(old.locationRevision) };
        db.prepare('UPDATE local_catalog_assets SET relative=?,data=? WHERE id=?').run(request.relative, JSON.stringify(result), old.id); return result;
      });
    },
    replaceAsset(request: ReplaceAudioAsset): dto.AudioAsset {
      return transaction('replace-asset', request, db => {
        const old = asset(db, request.assetId), selected = currentRoot(db, request.libraryRootId, request.expectedRootRevision);
        if (old.fileRevision !== request.expectedFileRevision || old.locationRevision !== request.expectedLocationRevision || old.libraryRootId !== selected.id) return access.conflict('资产修订或逻辑目录已改变。');
        const oldLocation = one(db, 'local_catalog_assets', old.id);
        const moved = oldLocation.relative !== request.relative || old.sourceRootId !== selected.sourceRootId;
        const result = { ...old, sourceRootId: selected.sourceRootId, rootRevision: selected.revision, fileRevision: next(old.fileRevision), locationRevision: moved ? next(old.locationRevision) : old.locationRevision, sampleFrames: request.sampleFrames, timebaseHz: request.timebaseHz };
        for (const row of db.prepare('SELECT * FROM local_catalog_tracks WHERE asset_id=?').iterate(old.id)) checkTrackSegment(readTrack(row), result);
        db.prepare('UPDATE local_catalog_assets SET source_root_id=?,relative=?,sha256=?,data=? WHERE id=?').run(selected.sourceRootId, request.relative, request.sha256, JSON.stringify(result), old.id); return result;
      });
    },
    asset(assetId: string): dto.AudioAsset { id(assetId); return access.read(db => asset(db, assetId)); },
    /** 仅Node owner私有准备接点；不经公开DTO/IPC暴露locator，也不新增授权真相。 */
    privateAssetLocator(assetId: string): { asset: dto.AudioAsset; relative: string } {
      id(assetId); return access.read(db => {
        const row = one(db, 'local_catalog_assets', assetId); boundedRow(row);
        const selected = readAsset(row); if (!relativePath(row.relative)) return corrupt();
        return { asset: { ...selected }, relative: row.relative };
      });
    },
    createTrack(request: CreateLocalTrack): dto.LocalTrack {
      return transaction('create-track', request, db => {
        const selected = asset(db, request.assetId);
        const result: dto.LocalTrack = { id: randomUUID(), assetId: selected.id, selectionRevision: '1', segment: request.segment === null ? null : { ...request.segment, id: randomUUID() } };
        checkTrackSegment(result, selected); db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(result.id, result.assetId, JSON.stringify(result)); return result;
      });
    },
    selectAsset(request: SelectLocalAsset): dto.LocalTrack {
      return transaction('select-asset', request, db => {
        const old = track(db, request.trackId); if (old.selectionRevision !== request.expectedSelectionRevision) return access.conflict('曲目选择修订已改变。');
        const selected = asset(db, request.assetId), result = { ...old, assetId: selected.id, selectionRevision: next(old.selectionRevision) };
        checkTrackSegment(result, selected); db.prepare('UPDATE local_catalog_tracks SET asset_id=?,data=? WHERE id=?').run(selected.id, JSON.stringify(result), old.id); return result;
      });
    },
    track(trackId: string): dto.LocalTrack { id(trackId); return access.read(db => track(db, trackId)); },
    pageTracks(page: dto.PageRequest): dto.Page<dto.LocalTrack> {
      if (!record(page) || !keys(page, ['offset', 'limit']) || !Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 200) return access.conflict('本地目录分页无效。');
      return access.read(db => { const total = Number(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n), items = db.prepare('SELECT * FROM local_catalog_tracks ORDER BY rowid LIMIT ? OFFSET ?').all(page.limit, page.offset).map(readTrack); return { ...page, total, items, hasMore: page.offset + items.length < total }; });
    },
    createEdition(request: CreateAlbumEdition): dto.AlbumEdition {
      return transaction('create-edition', request, db => { const result: dto.AlbumEdition = { id: randomUUID(), title: request.title, edition: request.edition, revision: '1' }; db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(result.id, JSON.stringify(result)); return result; });
    },
    edition(editionId: string): dto.AlbumEdition { id(editionId); return access.read(db => parse(one(db, 'local_catalog_editions', editionId).data, dto.isAlbumEdition)); },
    linkEditionTrack(request: LinkEditionTrack): dto.AlbumEditionTrack {
      return transaction('link-edition-track', request, db => {
        one(db, 'local_catalog_editions', request.editionId); track(db, request.trackId);
        if (db.prepare("SELECT 1 FROM local_catalog_edition_tracks WHERE edition_id=? AND json_extract(data,'$.sequence')=? AND json_extract(data,'$.active')=1").get(request.editionId, request.sequence)) return access.conflict('发行版序号已存在。');
        const result: dto.AlbumEditionTrack = { id: randomUUID(), editionId: request.editionId, trackId: request.trackId, disc: request.disc, trackNumber: request.trackNumber, sequence: request.sequence, revision: '1', active: true };
        db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(result.id, result.editionId, result.trackId, JSON.stringify(result)); return result;
      });
    },
    removeEditionTrack(request: RemoveEditionTrack): dto.AlbumEditionTrack {
      return transaction('remove-edition-track', request, db => {
        const old = parse(one(db, 'local_catalog_edition_tracks', request.id).data, dto.isAlbumEditionTrack);
        if (old.revision !== request.expectedRevision || !old.active) return access.conflict('发行版关系修订已改变。');
        const result = { ...old, revision: next(old.revision), active: false }; db.prepare('UPDATE local_catalog_edition_tracks SET data=? WHERE id=?').run(JSON.stringify(result), old.id); return result;
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
    observeMetadata(request: ObserveLocalMetadata): dto.LocalMetadataObservation {
      return transaction('observe-metadata', request, db => {
        track(db, request.trackId);
        const previous = db.prepare('SELECT data FROM local_catalog_observations WHERE track_id=? ORDER BY rowid DESC LIMIT 1').get(request.trackId);
        const result: dto.LocalMetadataObservation = { id: randomUUID(), trackId: request.trackId, revision: previous ? next(parse(previous.data, dto.isLocalMetadataObservation).revision) : '1', source: request.source, parserVersion: request.parserVersion, fields: { ...request.fields } };
        db.prepare('INSERT INTO local_catalog_observations VALUES(?,?,?)').run(result.id, result.trackId, JSON.stringify(result)); return result;
      });
    },
    overrideMetadata(request: OverrideLocalMetadata): dto.LocalMetadataOverride {
      return transaction('override-metadata', request, db => {
        track(db, request.trackId); const previous = db.prepare('SELECT data FROM local_catalog_overrides WHERE track_id=?').get(request.trackId);
        const old = previous ? parse(previous.data, dto.isLocalMetadataOverride) : null;
        if ((old?.revision ?? null) !== request.expectedRevision) return access.conflict('人工元数据修订已改变。');
        const result: dto.LocalMetadataOverride = { trackId: request.trackId, revision: old ? next(old.revision) : '1', fields: { ...request.fields } };
        db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?) ON CONFLICT(track_id) DO UPDATE SET data=excluded.data').run(result.trackId, JSON.stringify(result)); return result;
      });
    },
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
        track(db, trackId);
        const rows = db.prepare('SELECT data FROM local_catalog_observations WHERE track_id=? ORDER BY rowid LIMIT 201').all(trackId);
        if (rows.length > maxCatalogReadRows) throw new LocalCatalogBudgetError('有效元数据历史单次读取行数', rows.length, maxCatalogReadRows);
        const raw: dto.LocalMetadata = {};
        for (const row of rows) Object.assign(raw, parse(row.data, dto.isLocalMetadataObservation).fields);
        const row = db.prepare('SELECT data FROM local_catalog_overrides WHERE track_id=?').get(trackId), override = row ? parse(row.data, dto.isLocalMetadataOverride) : null;
        return { raw, override, effective: { ...raw, ...override?.fields } };
      });
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
