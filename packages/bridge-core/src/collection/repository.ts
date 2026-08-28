import { createRecordingPlanStore, recordingPlansMigration, type RecordingPlanStore } from '../recording/plan-store.js';
import { RecordingPlanError } from '../recording/plan-integrity.js';
import { createCollectionProgressStore, collectionProgressMigration, type CollectionProgressStore } from './collection-progress-store.js';
import { createSpreadsheetImportStore, spreadsheetImportMigration, type SpreadsheetImportStore } from './spreadsheet-import-store.js';
import { createCollectionSnapshot, type CollectionSnapshot } from '../recording/backup-snapshot.js';
import { createReferenceCatalogStore, referenceCatalogMigration, type ReferenceCatalogStore } from './reference-catalog-store.js';
import type { RootCapability } from '../recording/source-files.js';
import { archiveWorkflowMigration } from '../recording/archive-workflow-store.js';
import { archiveMigration, createArchiveStore, type ArchiveStore } from '../recording/archive-store.js';
import { executionMigration, createExecutionStore, type ExecutionStore } from '../recording/execution-store.js';
import { recordingProfilesMigration, createRecordingProfilesStore, type RecordingProfilesStore } from '../recording/profile-store.js';
import { preparedMigration, createPreparedStore, type PreparedStore } from '../recording/prepared-store.js';
import { masterVersionsMigration, createMasterVersionsStore, type MasterVersionsStore } from '../recording/versions-store.js';
import { preparationMigration, createPreparationStore, type PreparationStore } from '../recording/preparation-store.js';
import { mediaPlanningMigration, createMediaPlanningStore, type MediaPlanningStore } from '../recording/media-store.js';
import type { MediaStockCandidate } from '../recording/media-planner.js';
import type { MediaReservation, ReserveMediaRequest, ReleaseMediaRequest } from '@music-bridge/contracts';
import { sourceEvidenceMigration, createSourceStore, type SourceStore } from '../recording/source-store.js';
import { masterDraftsMigration, createMasterDraftsRepository, type MasterDraftsRepository } from '../recording/drafts.js';
import { physicalLinksMigration, createPhysicalLinksRepository, type PhysicalLinksRepository } from './physical-links.js';
import { physicalMusicMigration, createPhysicalMusicRepository, type PhysicalMusicRepository } from './physical-music.js';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  isCollectionId, isCollectionReceiveRequest, isCollectionMaterializeRequest,
  isCollectionUpdateCopyRequest, isCollectionPolicyRequest, isCollectionModel,
  isCollectionDetail, isCollectionMutationResult,
  isCollectionFilter, isCollectionAddPhotoRequest, isCollectionChangePhotoRequest, isCollectionPhotoImage,
  MAX_COLLECTION_PHOTO_BYTES, MAX_COLLECTION_PHOTOS_PER_MODEL,
  type CollectionFilter, type CollectionPhoto, type CollectionPhotoImage, type CollectionAddPhotoRequest, type CollectionChangePhotoRequest,
  type CollectionModel, type CollectionDetail, type CollectionLot, type CollectionCopy,
  type CollectionReceiveRequest, type CollectionMaterializeRequest,
  type CollectionUpdateCopyRequest, type CollectionPolicyRequest, type CollectionMutationResult,
  type CollectionDescriptor, type CollectionCounts, type CollectorPolicy, type Page, type PageRequest,
} from '@music-bridge/contracts';

export class CollectionError extends Error {
  constructor(readonly code: 'INVENTORY_CONFLICT' | 'INVENTORY_UNAVAILABLE', message: string) { super(message); }
}
const conflict = (message: string): never => { throw new CollectionError('INVENTORY_CONFLICT', message); };
const unavailable = (): never => { throw new CollectionError('INVENTORY_UNAVAILABLE', '库存暂时不可用，请重试；现有数据不会被自动清除。'); };

export interface CollectionRepository {
  recordingPlans: RecordingPlanStore;
  collectionProgress: CollectionProgressStore;
  spreadsheetImports: SpreadsheetImportStore;
  catalog: ReferenceCatalogStore;
  recordingProfiles: RecordingProfilesStore;
  execution: ExecutionStore;
  archive: ArchiveStore;
  music: PhysicalMusicRepository;
  drafts: MasterDraftsRepository;
  sources: SourceStore;
  media: MediaPlanningStore;
  versions: MasterVersionsStore;
  preparations: PreparationStore;
  prepared: PreparedStore;
  links: PhysicalLinksRepository;
  list(page: PageRequest, filter?: CollectionFilter): Page<CollectionModel>;
  addPhoto(request: CollectionAddPhotoRequest): CollectionMutationResult;
  photo(photoId: string): CollectionPhotoImage;
  changePhoto(request: CollectionChangePhotoRequest): CollectionMutationResult;
  detail(modelId: string, page: PageRequest): CollectionDetail;
  receive(request: CollectionReceiveRequest): CollectionMutationResult;
  materialize(request: CollectionMaterializeRequest): CollectionMutationResult;
  updateCopy(request: CollectionUpdateCopyRequest): CollectionMutationResult;
  setPolicy(request: CollectionPolicyRequest): CollectionMutationResult;
  backupSnapshot(destination: RootCapability): Promise<CollectionSnapshot>;
  close(): void;
}
interface ModelRow { id: string; descriptor: string; policy: CollectorPolicy; minimum_sealed: number; revision: number }
interface LotRow { quantity_adjustment: number; id: string; sku_id: string; model_id: string; minutes: number; acquired: number; sealed: number; opened: number; legacy: number; unknown: number }
interface CopyRow { recording_title?: string | null; physical_id: string; lot_id: string; sku_id: string; model_id: string; minutes: number; packaging: CollectionCopy['packaging']; usage: CollectionCopy['usage']; available: number; origin: CollectionCopy['origin']; revision: number; reserved_from: string | null }
interface PhotoRow { id: string; model_id: string; physical_id: string | null; width: number; height: number }

const schema = `
CREATE TABLE collection_models (
  id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, descriptor TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'normal' CHECK(policy IN ('normal','prefer-opened','preserve-sealed','collector')),
  minimum_sealed INTEGER NOT NULL DEFAULT 0 CHECK(minimum_sealed BETWEEN 0 AND 1000000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
CREATE TABLE collection_skus (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES collection_models(id),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 0 AND 360), UNIQUE(model_id, minutes)
) STRICT;
CREATE TABLE inventory_lots (
  id TEXT PRIMARY KEY, sku_id TEXT NOT NULL REFERENCES collection_skus(id),
  acquired INTEGER NOT NULL CHECK(acquired BETWEEN 1 AND 10000),
  sealed INTEGER NOT NULL CHECK(sealed >= 0), opened INTEGER NOT NULL CHECK(opened >= 0),
  legacy INTEGER NOT NULL CHECK(legacy >= 0), unknown INTEGER NOT NULL CHECK(unknown >= 0),
  CHECK(sealed + opened + legacy + unknown <= acquired)
) STRICT;
CREATE TABLE physical_sequences (format TEXT PRIMARY KEY, next_value INTEGER NOT NULL CHECK(next_value > 0)) STRICT;
INSERT INTO physical_sequences VALUES ('cassette',1),('dat',1);
CREATE TABLE physical_copies (
  physical_id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  packaging TEXT NOT NULL CHECK(packaging IN ('sealed','opened','unknown')),
  usage TEXT NOT NULL CHECK(usage IN ('blank','reserved','recorded','unknown','erased')),
  available INTEGER NOT NULL CHECK(available IN (0,1)),
  origin TEXT NOT NULL CHECK(origin IN ('blank-pool','legacy-registration','unclassified')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), reserved_from TEXT,
  CHECK((usage='reserved' AND reserved_from IN ('blank','erased')) OR (usage<>'reserved' AND reserved_from IS NULL))
) STRICT;
CREATE TABLE inventory_ledger (
  command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL,
  result TEXT NOT NULL, event_data TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX inventory_lots_sku ON inventory_lots(sku_id);
CREATE INDEX physical_copies_lot ON physical_copies(lot_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON inventory_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON inventory_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=1;
`;
const photoMigration = `
CREATE TABLE collection_photos (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES collection_models(id),
  physical_id TEXT REFERENCES physical_copies(physical_id),
  content BLOB NOT NULL CHECK(length(content) BETWEEN 4 AND 1048576),
  content_hash TEXT NOT NULL, width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1200),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1200)
) STRICT;
CREATE UNIQUE INDEX collection_photo_identity ON collection_photos(model_id,COALESCE(physical_id,''),content_hash);
CREATE TABLE collection_featured_photos (
  model_id TEXT PRIMARY KEY REFERENCES collection_models(id),
  photo_id TEXT NOT NULL REFERENCES collection_photos(id) ON DELETE CASCADE
) STRICT;
PRAGMA user_version=2;
`;
function publicPhoto(row: PhotoRow): CollectionPhoto {
  return { id: row.id, modelId: row.model_id, ...(row.physical_id ? { physicalId: row.physical_id } : {}), width: row.width, height: row.height, source: 'user-photo' };
}
const lotSelect = 'SELECT l.*, s.model_id, s.minutes FROM inventory_lots l JOIN collection_skus s ON s.id=l.sku_id';
const copySelect = "SELECT c.*, l.sku_id, s.model_id, s.minutes,json_extract(r.data,'$.title') recording_title FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id LEFT JOIN legacy_recording_content r ON r.physical_id=c.physical_id";
const columns = { sealedBlank: 'sealed', openedBlank: 'opened', legacyUsed: 'legacy', unclassified: 'unknown' } as const;
const normalized = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function validPage(page: PageRequest): boolean {
  return Number.isSafeInteger(page?.offset) && page.offset >= 0 && page.offset <= 1_000_000
    && Number.isSafeInteger(page?.limit) && page.limit >= 1 && page.limit <= 100;
}
function paged<T>(items: T[], page: PageRequest, total: number): Page<T> {
  return { items, ...page, total, hasMore: page.offset + items.length < total };
}

export function createCollectionRepository(options: { filePath: string; beforeCommit?: (action: string) => void }): CollectionRepository {
  let database: DatabaseSync | undefined;
  let closed = false;
  let activeSnapshots = 0;

  function open(): DatabaseSync {
    if (closed) return unavailable();
    if (database) return database;
    if (options.filePath !== ':memory:') {
      if (!path.isAbsolute(options.filePath)) return unavailable();
      const directory = path.dirname(options.filePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) return unavailable();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          const info = lstatSync(options.filePath + suffix);
          if (!info.isFile() || info.isSymbolicLink()) return unavailable();
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const fd = openSync(options.filePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    }
    const db = new DatabaseSync(options.filePath, { enableForeignKeyConstraints: true, allowExtension: false });
    try {
      // WAL 恢复期间，首次版本读取也可能遇到短暂锁；先设置等待，再访问数据库内容。
      db.exec('PRAGMA busy_timeout=1000');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].includes(version)) return unavailable();
      if (version === 0 && Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.n) !== 0) return unavailable();
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (version < 18) {
        // 重建被其他表引用的批次表：事务外暂关检查，提交前核验，退出时始终恢复。
        db.exec('PRAGMA foreign_keys=OFF');
        db.exec('BEGIN IMMEDIATE');
        try {
          // 等待写锁后重读版本，避免两个首次连接同时执行迁移。
          const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
          if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].includes(currentVersion)) return unavailable();
          if (currentVersion === 0) db.exec(schema);
          if (currentVersion < 2) { db.exec(photoMigration); options.beforeCommit?.('migrate-photos'); }
          if (currentVersion < 3) { db.exec(physicalMusicMigration); options.beforeCommit?.('migrate-music'); }
          if (currentVersion < 4) { db.exec(physicalLinksMigration); options.beforeCommit?.('migrate-links'); }
          if (currentVersion < 5) { db.exec(masterDraftsMigration); options.beforeCommit?.('migrate-drafts'); }
          if (currentVersion < 6) { db.exec(sourceEvidenceMigration); options.beforeCommit?.('migrate-sources'); }
          if (currentVersion < 7) { db.exec(mediaPlanningMigration); options.beforeCommit?.('migrate-media-planning'); }
          if (currentVersion < 8) { db.exec(masterVersionsMigration); options.beforeCommit?.('migrate-master-versions'); }
          if (currentVersion < 9) { db.exec(preparationMigration); options.beforeCommit?.('migrate-preparation'); }
          if (currentVersion < 10) { db.exec(preparedMigration); options.beforeCommit?.('migrate-prepared'); }
          if (currentVersion < 11) { db.exec(recordingProfilesMigration); options.beforeCommit?.('migrate-recording-profiles'); }
          if (currentVersion < 12) { db.exec(executionMigration); options.beforeCommit?.('migrate-execution'); }
          if (currentVersion < 13) { db.exec(archiveMigration); options.beforeCommit?.('migrate-archive'); }
          if (currentVersion < 14) { db.exec(archiveWorkflowMigration); options.beforeCommit?.('migrate-archive-workflow'); }
          if (currentVersion < 15) { db.exec(referenceCatalogMigration); options.beforeCommit?.('migrate-reference-catalog'); }
          if (currentVersion < 16) { db.exec(spreadsheetImportMigration); options.beforeCommit?.('migrate-spreadsheet-imports'); }
          if (currentVersion < 17) { db.exec(collectionProgressMigration); options.beforeCommit?.('migrate-collection-progress'); }
          if (currentVersion < 18) { db.exec(recordingPlansMigration); options.beforeCommit?.('migrate-recording-plans'); }
          if (db.prepare('PRAGMA foreign_key_check').get()) return unavailable();
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        finally { db.exec('PRAGMA foreign_keys=ON'); }
      }
      database = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }
  function guarded<T>(operation: (db: DatabaseSync) => T): T {
    try { return operation(open()); }
    catch (error) { if (error instanceof CollectionError || error instanceof RecordingPlanError) throw error; return unavailable(); }
  }
  function one<T>(db: DatabaseSync, sql: string, ...values: SQLInputValue[]): T | undefined {
    return db.prepare(sql).get(...values) as unknown as T | undefined;
  }
  function many<T>(db: DatabaseSync, sql: string, ...values: SQLInputValue[]): T[] {
    return db.prepare(sql).all(...values) as unknown as T[];
  }
  const count = (db: DatabaseSync, sql: string, ...values: SQLInputValue[]): number => Number(db.prepare(sql).get(...values)?.n ?? 0);

  function counts(db: DatabaseSync, modelId: string): CollectionCounts {
    const pools = db.prepare(`SELECT COALESCE(SUM(sealed),0) AS sealed, COALESCE(SUM(opened),0) AS opened,
      COALESCE(SUM(legacy),0) AS legacy, COALESCE(SUM(unknown),0) AS unknown
      FROM inventory_lots l JOIN collection_skus s ON s.id=l.sku_id WHERE s.model_id=?`).get(modelId)!;
    const copies = db.prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(c.available=0),0) AS unavailable,
      COALESCE(SUM(c.available=1 AND c.usage='reserved'),0) AS reserved,
      COALESCE(SUM(c.available=1 AND c.usage='recorded'),0) AS recorded,
      COALESCE(SUM(c.available=1 AND c.usage IN ('blank','erased') AND c.packaging='sealed'),0) AS sealed,
      COALESCE(SUM(c.available=1 AND c.usage IN ('blank','erased') AND c.packaging='opened'),0) AS opened,
      COALESCE(SUM(c.available=1 AND (c.usage='unknown' OR (c.usage IN ('blank','erased') AND c.packaging='unknown'))),0) AS unknown
      FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id WHERE s.model_id=?`).get(modelId)!;
    return {
      total: Number(pools.sealed) + Number(pools.opened) + Number(pools.legacy) + Number(pools.unknown) + Number(copies.n),
      sealedBlank: Number(pools.sealed) + Number(copies.sealed), openedBlank: Number(pools.opened) + Number(copies.opened),
      legacyUsed: Number(pools.legacy), unknown: Number(pools.unknown) + Number(copies.unknown),
      recorded: Number(copies.recorded), reserved: Number(copies.reserved), unavailable: Number(copies.unavailable),
    };
  }
  function model(db: DatabaseSync, id: string): CollectionModel {
    const row = one<ModelRow>(db, 'SELECT * FROM collection_models WHERE id=?', id);
    if (!row) return conflict('型号不存在，请刷新收藏。');
    const featured = one<PhotoRow>(db, 'SELECT p.id,p.model_id,p.physical_id,p.width,p.height FROM collection_photos p LEFT JOIN collection_featured_photos f ON f.model_id=p.model_id WHERE p.model_id=? ORDER BY (f.photo_id=p.id) DESC,p.rowid LIMIT 1', id);
    const result = { ...JSON.parse(row.descriptor) as CollectionDescriptor, id: row.id,
      collectorPolicy: row.policy, minimumSealedReserve: row.minimum_sealed, revision: row.revision,
      lengths: many<{ minutes: number }>(db, 'SELECT minutes FROM collection_skus WHERE model_id=? ORDER BY minutes', id).map(s => s.minutes || null),
      counts: counts(db, id), photoCount: count(db, 'SELECT COUNT(*) AS n FROM collection_photos WHERE model_id=?', id),
      ...(featured ? { featuredPhoto: publicPhoto(featured) } : {}) };
    if (!isCollectionModel(result)) return unavailable();
    return result;
  }
  function ensureConsumable(db: DatabaseSync, modelId: string, sealed: boolean): void {
    const m = model(db, modelId);
    if (m.collectorPolicy === 'collector') conflict('该型号设为收藏保护，请先明确修改保护策略。');
    if (sealed && (m.collectorPolicy === 'preserve-sealed' || m.counts.sealedBlank <= m.minimumSealedReserve)) conflict('该操作触及封存保护或最低保留数量。');
  }
  function publicCopy(row: CopyRow): CollectionCopy {
    return { physicalId: row.physical_id, lotId: row.lot_id, skuId: row.sku_id, lengthMinutes: row.minutes || null,
      packaging: row.packaging, usage: row.usage, available: row.available === 1, origin: row.origin, revision: row.revision, ...(row.usage === 'recorded' && row.recording_title ? { recordingTitle: row.recording_title } : {}) };
  }
  function transaction<T extends { commandId: string }>(action: string, request: T, valid: boolean,
    operation: (db: DatabaseSync) => { result: CollectionMutationResult; evidence: unknown }): CollectionMutationResult {
    if (!valid) return conflict('库存请求无效，请检查输入。');
    const fingerprint = createHash('sha256').update(canonical({ action, request })).digest('hex');
    return guarded(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = one<{ fingerprint: string; result: string }>(db, 'SELECT fingerprint,result FROM inventory_ledger WHERE command_id=?', request.commandId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同内容，请刷新后重新操作。');
          const result: unknown = JSON.parse(prior.result);
          if (!isCollectionMutationResult(result)) return unavailable();
          db.exec('COMMIT'); return result;
        }
        const { result, evidence } = operation(db);
        if (!isCollectionMutationResult(result)) return unavailable();
        // 写入余额、永久编号与幂等结果处于同一事务；不在提交后自动重试不同操作。
        db.prepare('INSERT INTO inventory_ledger VALUES (?,?,?,?,?,?)').run(request.commandId, fingerprint, action, JSON.stringify(result), JSON.stringify(evidence), new Date().toISOString());
        options.beforeCommit?.(action);
        db.exec('COMMIT'); return result;
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 保留原故障；下次由 SQLite 恢复。 */ } throw error; }
    });
  }

  const mediaStockSql = `WITH pools AS (
    SELECT sku_id,SUM(opened) opened,SUM(sealed) sealed FROM inventory_lots GROUP BY sku_id
  ), copies AS (
    SELECT l.sku_id,SUM(c.packaging='opened') opened,SUM(c.packaging='sealed') sealed
    FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id
    WHERE c.available=1 AND c.usage IN ('blank','erased') AND c.packaging IN ('opened','sealed') GROUP BY l.sku_id
  ), balances AS (
    SELECT s.id sku_id,s.model_id,s.minutes,COALESCE(p.opened,0)+COALESCE(c.opened,0) opened,COALESCE(p.sealed,0)+COALESCE(c.sealed,0) sealed
    FROM collection_skus s LEFT JOIN pools p ON p.sku_id=s.id LEFT JOIN copies c ON c.sku_id=s.id
  ), candidates AS (
    SELECT sku_id,model_id,minutes,'opened' packaging,opened amount FROM balances WHERE opened>0
    UNION ALL SELECT sku_id,model_id,minutes,'sealed' packaging,sealed amount FROM balances WHERE sealed>0
  ) SELECT candidates.*,m.policy,json_extract(m.descriptor,'$.format') format FROM candidates JOIN collection_models m ON m.id=candidates.model_id`;
  interface StockRow { sku_id: string; model_id: string; minutes: number; packaging: 'opened' | 'sealed'; amount: number }
  function stockCandidate(db: DatabaseSync, row: StockRow): MediaStockCandidate { return { skuId: row.sku_id, model: model(db, row.model_id), lengthMinutes: row.minutes || null, packaging: row.packaging, availableCount: Number(row.amount) }; }
  function mediaStock(db: DatabaseSync, page: PageRequest, format: 'cassette' | 'dat'): Page<MediaStockCandidate> {
    if (!validPage(page) || !['cassette','dat'].includes(format)) return conflict('库存候选查询无效。');
    const sql = `SELECT * FROM (${mediaStockSql}) WHERE format=?`;
    const total = count(db, `SELECT COUNT(*) n FROM (${sql})`, format);
    const rows = many<StockRow>(db, `${sql} ORDER BY (policy='collector' OR (policy='preserve-sealed' AND packaging='sealed')),packaging='opened' DESC,minutes=0,minutes,model_id,sku_id LIMIT ? OFFSET ?`, format, page.limit, page.offset);
    return paged(rows.map(row => stockCandidate(db, row)), page, total);
  }
  function mediaStockOne(db: DatabaseSync, skuId: string, packaging: 'opened' | 'sealed'): MediaStockCandidate | undefined {
    const row = one<StockRow>(db, `SELECT * FROM (${mediaStockSql}) WHERE sku_id=? AND packaging=?`, skuId, packaging);
    return row ? stockCandidate(db, row) : undefined;
  }
  function reservedMediaStock(db: DatabaseSync, reservation: MediaReservation): MediaStockCandidate | undefined {
    const copy = one<CopyRow>(db, `${copySelect} WHERE c.physical_id=?`, reservation.physicalId);
    if (!copy || copy.usage !== 'reserved' || !copy.available || copy.sku_id !== reservation.skuId || copy.packaging !== reservation.packaging) return undefined;
    const current = model(db, copy.model_id);
    // 复核已有预留时把它计回可用基数，不能把最低保留线重复扣减一遍。
    const adjusted = copy.packaging === 'sealed' ? { ...current, counts: { ...current.counts, sealedBlank: current.counts.sealedBlank + 1 } } : current;
    return { skuId: copy.sku_id, model: adjusted, lengthMinutes: copy.minutes || null, packaging: reservation.packaging, availableCount: 1 };
  }
  function mediaStockLedger(db: DatabaseSync, action: string, request: ReserveMediaRequest | ReleaseMediaRequest, result: CollectionMutationResult, evidence: unknown): void {
    const fingerprint = createHash('sha256').update(canonical({ action, request })).digest('hex');
    db.prepare('INSERT INTO inventory_ledger VALUES (?,?,?,?,?,?)').run(request.commandId, fingerprint, action, JSON.stringify(result), JSON.stringify(evidence), new Date().toISOString());
  }
  function reserveMediaStock(db: DatabaseSync, request: ReserveMediaRequest): MediaReservation {
    const sku = one<{ id: string; model_id: string }>(db, 'SELECT id,model_id FROM collection_skus WHERE id=?', request.skuId);
    if (!sku) return conflict('库存时长规格不存在。');
    ensureConsumable(db, sku.model_id, request.packaging === 'sealed');
    let copy = one<CopyRow>(db, `${copySelect} WHERE l.sku_id=? AND c.available=1 AND c.usage IN ('blank','erased') AND c.packaging=? ORDER BY c.physical_id LIMIT 1`, request.skuId, request.packaging);
    let poolEvidence: unknown;
    if (!copy) {
      const column = request.packaging === 'opened' ? 'opened' : 'sealed';
      const lot = one<{ id: string }>(db, `SELECT id FROM inventory_lots WHERE sku_id=? AND ${column}>0 ORDER BY rowid LIMIT 1`, request.skuId);
      if (!lot) return conflict('这类空白磁带已无可用数量。');
      const materialized = materializeInTransaction(db, { commandId: request.commandId, lotId: lot.id, bucket: request.packaging === 'opened' ? 'openedBlank' : 'sealedBlank', action: 'identify' });
      poolEvidence = materialized.evidence;
      copy = one<CopyRow>(db, `${copySelect} WHERE c.physical_id=?`, materialized.result.physicalId);
    }
    if (!copy || !['blank','erased'].includes(copy.usage)) return conflict('副本已被其他操作占用。');
    const before = publicCopy(copy);
    db.prepare("UPDATE physical_copies SET usage='reserved',reserved_from=usage,revision=revision+1 WHERE physical_id=?").run(copy.physical_id);
    const reservation: MediaReservation = { physicalId: copy.physical_id, modelId: sku.model_id, skuId: sku.id, packaging: request.packaging };
    mediaStockLedger(db, 'recording-reserve', request, { modelId: sku.model_id, lotId: copy.lot_id, physicalId: copy.physical_id }, { planId: request.planId, before, reservation, ...(poolEvidence ? { poolEvidence } : {}) });
    return reservation;
  }
  function releaseMediaStock(db: DatabaseSync, request: ReleaseMediaRequest, reservation: MediaReservation): void {
    const copy = one<CopyRow>(db, `${copySelect} WHERE c.physical_id=?`, reservation.physicalId);
    if (!copy || copy.usage !== 'reserved' || !['blank','erased'].includes(copy.reserved_from ?? '')) return conflict('预留副本状态不一致，请停止并检查库存。');
    db.prepare('UPDATE physical_copies SET usage=reserved_from,reserved_from=NULL,revision=revision+1 WHERE physical_id=?').run(copy.physical_id);
    mediaStockLedger(db, 'recording-release', request, { modelId: copy.model_id, lotId: copy.lot_id, physicalId: copy.physical_id }, { planId: request.planId, before: publicCopy(copy), restoredUsage: copy.reserved_from });
  }
  function materializeInTransaction(db: DatabaseSync, request: CollectionMaterializeRequest) {
    const lot = one<LotRow>(db, `${lotSelect} WHERE l.id=?`, request.lotId);
    if (!lot || lot[columns[request.bucket]] < 1) return conflict('库存不足，请刷新后重试。');
    if (request.action === 'open') ensureConsumable(db, lot.model_id, true);
    const descriptor = model(db, lot.model_id);
    const sequence = one<{ next_value: number }>(db, 'SELECT next_value FROM physical_sequences WHERE format=?', descriptor.format)!.next_value;
    if (sequence > 999_999_999) return conflict('实体编号已达当前上限。');
    const physicalId = `MB-${descriptor.format === 'cassette' ? 'C' : 'D'}-${String(sequence).padStart(5, '0')}`;
    db.prepare('UPDATE physical_sequences SET next_value=next_value+1 WHERE format=?').run(descriptor.format);
    const column = columns[request.bucket];
    db.prepare(`UPDATE inventory_lots SET ${column}=${column}-1 WHERE id=?`).run(request.lotId);
    const packaging = request.bucket === 'unclassified' ? 'unknown' : request.bucket === 'sealedBlank' && request.action !== 'open' ? 'sealed' : 'opened';
    const usage = request.bucket === 'legacyUsed' ? 'recorded' : request.bucket === 'unclassified' ? 'unknown' : 'blank';
    const origin = request.bucket === 'legacyUsed' ? 'legacy-registration' : request.bucket === 'unclassified' ? 'unclassified' : 'blank-pool';
    db.prepare('INSERT INTO physical_copies(physical_id,lot_id,packaging,usage,available,origin) VALUES (?,?,?,?,1,?)').run(physicalId, request.lotId, packaging, usage, origin);
    return { result: { modelId: lot.model_id, lotId: lot.id, physicalId }, evidence: { kind: 'POOL_TO_COPY', bucket: request.bucket, before: lot[column], after: lot[column] - 1, packaging, usage, origin } };
  }
  function receiveInTransaction(db: DatabaseSync, request: CollectionReceiveRequest, privateIdentity?: string): { result: CollectionMutationResult; evidence: unknown } {
        const descriptor = { ...request.model, brand: normalized(request.model.brand), name: normalized(request.model.name), edition: normalized(request.model.edition) };
        const { identification: _identification, ...identity } = descriptor;
        const identityKey = privateIdentity ?? createHash('sha256').update(canonical({ ...identity, brand: identity.brand.toLocaleLowerCase('en-US'), name: identity.name.toLocaleLowerCase('en-US'), edition: identity.edition.toLocaleLowerCase('en-US') })).digest('hex');
        let modelId = one<{ id: string }>(db, 'SELECT id FROM collection_models WHERE identity_key=?', identityKey)?.id;
        if (!modelId) {
          if (count(db, 'SELECT COUNT(*) AS n FROM collection_models') >= 10_000) return conflict('型号数量已达当前上限。');
          modelId = randomUUID(); db.prepare('INSERT INTO collection_models(id,identity_key,descriptor) VALUES (?,?,?)').run(modelId, identityKey, JSON.stringify(descriptor));
        }
        const amount = Object.values(request.quantities).reduce((sum, n) => sum + n, 0);
        if (counts(db, modelId).total + amount > 1_000_000) return conflict('该型号库存已达当前上限。');
        let skuId = one<{ id: string }>(db, 'SELECT id FROM collection_skus WHERE model_id=? AND minutes=?', modelId, request.lengthMinutes ?? 0)?.id;
        if (!skuId) {
          if (count(db, 'SELECT COUNT(*) AS n FROM collection_skus WHERE model_id=?', modelId) >= 100) return conflict('该型号时长种类已达当前上限。');
          skuId = randomUUID(); db.prepare('INSERT INTO collection_skus VALUES (?,?,?)').run(skuId, modelId, request.lengthMinutes ?? 0);
        }
        const lotId = randomUUID(), q = request.quantities;
        db.prepare('INSERT INTO inventory_lots(id,sku_id,acquired,sealed,opened,legacy,unknown) VALUES (?,?,?,?,?,?,?)').run(lotId, skuId, amount, q.sealedBlank, q.openedBlank, q.legacyUsed, q.unclassified);
        return { result: { modelId, lotId }, evidence: { kind: 'RECEIVE', quantityAcquired: amount, quantities: q } };
  }

  const music = createPhysicalMusicRepository({ read: guarded, conflict, unavailable, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  const links = createPhysicalLinksRepository({ read: guarded, conflict, unavailable, music, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  const media = createMediaPlanningStore({ read: guarded, conflict, unavailable, stock: mediaStock, stockOne: mediaStockOne, reservationStock: reservedMediaStock, reserve: reserveMediaStock, release: releaseMediaStock, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  return {
    recordingPlans: createRecordingPlanStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    collectionProgress: createCollectionProgressStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    spreadsheetImports: createSpreadsheetImportStore({ read: guarded, conflict, receive: receiveInTransaction, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    catalog: createReferenceCatalogStore({ read: guarded, model, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    music, links,
    archive: createArchiveStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    execution: createExecutionStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    recordingProfiles: createRecordingProfilesStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    prepared: createPreparedStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    preparations: createPreparationStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    versions: createMasterVersionsStore({ read: guarded, conflict, media, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    media,
    sources: createSourceStore({ read: guarded, conflict, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    drafts: createMasterDraftsRepository({ read: guarded, conflict, unavailable, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) }),
    list(page, filter = {}) {
      if (!validPage(page) || !isCollectionFilter(filter)) return conflict('库存请求无效，请检查分页和筛选。');
      const conditions: string[] = [], values: SQLInputValue[] = [];
      if (filter.query?.trim()) {
        conditions.push("instr(lower(json_extract(descriptor,'$.brand') || ' ' || json_extract(descriptor,'$.name') || ' ' || json_extract(descriptor,'$.edition')), ?) > 0");
        values.push(normalized(filter.query).toLowerCase());
      }
      if (filter.brand?.trim()) { conditions.push("lower(json_extract(descriptor,'$.brand'))=?"); values.push(normalized(filter.brand).toLowerCase()); }
      if (filter.decade === 'unknown') conditions.push("json_extract(descriptor,'$.year') IS NULL");
      else if (filter.decade !== undefined) { conditions.push("json_extract(descriptor,'$.year') BETWEEN ? AND ?"); values.push(filter.decade, filter.decade + 9); }
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      return guarded(db => paged(many<{ id: string }>(db, `SELECT id FROM collection_models${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`, ...values, page.limit, page.offset).map(r => model(db, r.id)), page, count(db, `SELECT COUNT(*) AS n FROM collection_models${where}`, ...values)));
    },
    detail(modelId, page) {
      if (!isCollectionId(modelId) || !validPage(page)) return conflict('库存请求无效，请检查型号和分页。');
      return guarded(db => {
        const lots = many<LotRow>(db, `${lotSelect} WHERE s.model_id=? ORDER BY l.rowid DESC LIMIT ? OFFSET ?`, modelId, page.limit, page.offset);
        const copies = many<CopyRow>(db, `${copySelect} WHERE s.model_id=? ORDER BY c.rowid DESC LIMIT ? OFFSET ?`, modelId, page.limit, page.offset);
        const detail: CollectionDetail = { model: model(db, modelId),
          photos: many<PhotoRow>(db, 'SELECT id,model_id,physical_id,width,height FROM collection_photos WHERE model_id=? ORDER BY rowid', modelId).map(publicPhoto),
          lots: paged(lots.map((r): CollectionLot => ({ id: r.id, skuId: r.sku_id, lengthMinutes: r.minutes || null, quantityAcquired: r.acquired, quantityAdjustment: r.quantity_adjustment,
            quantities: { sealedBlank: r.sealed, openedBlank: r.opened, legacyUsed: r.legacy, unclassified: r.unknown } })), page,
          count(db, 'SELECT COUNT(*) AS n FROM inventory_lots l JOIN collection_skus s ON s.id=l.sku_id WHERE s.model_id=?', modelId)),
          copies: paged(copies.map(publicCopy), page, count(db, 'SELECT COUNT(*) AS n FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id WHERE s.model_id=?', modelId)),
        };
        if (!isCollectionDetail(detail)) return unavailable();
        return detail;
      });
    },
    receive(request) { return transaction('receive', request, isCollectionReceiveRequest(request), db => receiveInTransaction(db, request)); },
    materialize(request) { return transaction('materialize', request, isCollectionMaterializeRequest(request), db => materializeInTransaction(db, request)); },
    updateCopy(request) {
      return transaction('update-copy', request, isCollectionUpdateCopyRequest(request), db => {
        const copy = one<CopyRow>(db, `${copySelect} WHERE c.physical_id=?`, request.physicalId);
        if (!copy || copy.revision !== request.expectedRevision) return conflict('副本已改变，请刷新后重试。');
        let usage = copy.usage, available = copy.available, reservedFrom = copy.reserved_from;
        if (request.action === 'reserve') {
          if (!available || !['blank', 'erased'].includes(usage) || copy.packaging === 'unknown') return conflict('仅可预留状态已确认且可用的空白副本。');
          ensureConsumable(db, copy.model_id, copy.packaging === 'sealed');
          reservedFrom = usage; usage = 'reserved';
        } else if (request.action === 'cancel-reservation') {
          if (db.prepare('SELECT 1 FROM media_reservations WHERE physical_id=?').get(request.physicalId)) return conflict('这盘磁带属于录音规划，请从该规划取消预留。');
          if (usage !== 'reserved' || !['blank', 'erased'].includes(reservedFrom ?? '')) return conflict('该副本没有可取消的预留。');
          usage = reservedFrom as 'blank' | 'erased'; reservedFrom = null;
        } else available = request.action === 'mark-available' ? 1 : 0;
        db.prepare('UPDATE physical_copies SET usage=?,available=?,reserved_from=?,revision=revision+1 WHERE physical_id=?').run(usage, available, reservedFrom, request.physicalId);
        return { result: { modelId: copy.model_id, lotId: copy.lot_id, physicalId: copy.physical_id }, evidence: { kind: request.action, before: publicCopy(copy), after: { usage, available: available === 1, revision: copy.revision + 1 } } };
      });
    },
    setPolicy(request) {
      return transaction('set-policy', request, isCollectionPolicyRequest(request), db => {
        const prior = model(db, request.modelId);
        if (prior.revision !== request.expectedRevision) return conflict('型号已改变，请刷新后重试。');
        db.prepare('UPDATE collection_models SET policy=?,minimum_sealed=?,revision=revision+1 WHERE id=?').run(request.collectorPolicy, request.minimumSealedReserve, request.modelId);
        return { result: { modelId: request.modelId }, evidence: { kind: 'POLICY_CHANGED', before: { policy: prior.collectorPolicy, minimumSealedReserve: prior.minimumSealedReserve }, after: { policy: request.collectorPolicy, minimumSealedReserve: request.minimumSealedReserve } } };
      });
    },
    addPhoto(request) {
      return transaction('add-photo', request, isCollectionAddPhotoRequest(request), db => {
        model(db, request.modelId);
        if (request.physicalId) {
          const copy = one<CopyRow>(db, `${copySelect} WHERE c.physical_id=?`, request.physicalId);
          if (!copy || copy.model_id !== request.modelId) return conflict('该单盘不属于此型号。');
        }
        const content = Buffer.from(request.image.dataUrl.slice(23), 'base64');
        if (content.length > MAX_COLLECTION_PHOTO_BYTES || content.toString('base64') !== request.image.dataUrl.slice(23) || content.at(-2) !== 0xff || content.at(-1) !== 0xd9) return conflict('照片内容无效。');
        const hash = createHash('sha256').update(content).digest('hex');
        const duplicate = one<{ id: string }>(db, "SELECT id FROM collection_photos WHERE model_id=? AND COALESCE(physical_id,'')=? AND content_hash=?", request.modelId, request.physicalId ?? '', hash);
        if (duplicate) return { result: { modelId: request.modelId, photoId: duplicate.id }, evidence: { kind: 'PHOTO_DUPLICATE', hash } };
        if (count(db, 'SELECT COUNT(*) AS n FROM collection_photos WHERE model_id=?', request.modelId) >= MAX_COLLECTION_PHOTOS_PER_MODEL) return conflict('每个型号最多保存 24 张照片，请先移除不需要的照片。');
        const photoId = randomUUID();
        db.prepare('INSERT INTO collection_photos VALUES (?,?,?,?,?,?,?)').run(photoId, request.modelId, request.physicalId ?? null, content, hash, request.image.width, request.image.height);
        db.prepare('UPDATE collection_models SET revision=revision+1 WHERE id=?').run(request.modelId);
        return { result: { modelId: request.modelId, photoId }, evidence: { kind: 'PHOTO_ADDED', hash, physicalId: request.physicalId ?? null } };
      });
    },
    photo(photoId) {
      if (!isCollectionId(photoId)) return conflict('照片编号无效。');
      return guarded(db => {
        const row = one<PhotoRow & { content: Uint8Array; content_hash: string }>(db, 'SELECT * FROM collection_photos WHERE id=?', photoId);
        if (!row) return conflict('照片不存在或已移除。');
        const bytes = Buffer.from(row.content);
        if (createHash('sha256').update(bytes).digest('hex') !== row.content_hash) return unavailable();
        const result = { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, width: row.width, height: row.height };
        if (!isCollectionPhotoImage(result)) return unavailable();
        return result;
      });
    },
    changePhoto(request) {
      return transaction('change-photo', request, isCollectionChangePhotoRequest(request), db => {
        const current = model(db, request.modelId);
        if (current.revision !== request.expectedRevision) return conflict('型号已改变，请刷新后重试。');
        const photo = one<PhotoRow>(db, 'SELECT id,model_id,physical_id,width,height FROM collection_photos WHERE id=?', request.photoId);
        if (!photo || photo.model_id !== request.modelId) return conflict('照片不存在或不属于此型号。');
        if (request.action === 'remove') db.prepare('DELETE FROM collection_photos WHERE id=?').run(request.photoId);
        else db.prepare('INSERT INTO collection_featured_photos VALUES (?,?) ON CONFLICT(model_id) DO UPDATE SET photo_id=excluded.photo_id').run(request.modelId, request.photoId);
        db.prepare('UPDATE collection_models SET revision=revision+1 WHERE id=?').run(request.modelId);
        return { result: { modelId: request.modelId, photoId: request.photoId }, evidence: { kind: request.action === 'remove' ? 'PHOTO_REMOVED' : 'FEATURED_PHOTO', photoId: request.photoId } };
      });
    },
    backupSnapshot(destination) {
      return guarded(db => {
        activeSnapshots++;
        return createCollectionSnapshot(db, destination).finally(() => {
          activeSnapshots--;
          if (closed && activeSnapshots === 0) { database?.close(); database = undefined; }
        });
      });
    },
    close() {
      closed = true;
      if (activeSnapshots === 0) { database?.close(); database = undefined; }
    },
  };
}
