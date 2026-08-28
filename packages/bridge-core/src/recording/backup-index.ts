import { verifyRecordingRecordDatabase } from './record-integrity.js';
import { verifyRecordingPlanDatabase } from './plan-integrity.js';
import { verifyRecordingAttemptDatabase } from './attempt-integrity.js';
import { verifyCollectionProgressDatabase } from '../collection/collection-progress-store.js';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCollectionId } from '@music-bridge/contracts';
import { archiveDigest, archiveManifest, type OwnedArchiveOperation } from './archive-files.js';
import type { StoredArchiveOperation } from './archive-store.js';
import { backupFail } from './backup-files.js';
import { verifyReferenceCatalogDatabase } from '../collection/reference-catalog-store.js';
import { verifySpreadsheetImportDatabase } from '../collection/spreadsheet-import-store.js';

export interface BackupObject { sha256: string; size: number; rootIds: string[] }
export interface BackupOperation { operationId: string; rootId: string; manifestHash: string; manifestSize: number }
export interface BackupIndex { operations: BackupOperation[]; objects: BackupObject[]; incompleteOperationIds: string[] }
/** 只读取已经关闭写入的快照，外部路径仅作为恢复前的未授权历史引用保留。 */
export function readBackupIndex(databasePath: string): { index: BackupIndex; owned: OwnedArchiveOperation[] } {
  if (!path.isAbsolute(databasePath)) backupFail();
  const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 14 && version !== 15 && version !== 16 && version !== 17 && version !== 18 && version !== 19 && version !== 20 || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) backupFail();
    if (Number(version) >= 15) verifyReferenceCatalogDatabase(db);
    if (Number(version) >= 16) verifySpreadsheetImportDatabase(db);
    if (Number(version) >= 17) verifyCollectionProgressDatabase(db);
    if (Number(version) >= 18) verifyRecordingPlanDatabase(db);
    if (Number(version) >= 19) verifyRecordingAttemptDatabase(db);
    if (Number(version) >= 20) verifyRecordingRecordDatabase(db);
    const count = Number(db.prepare('SELECT count(*) n FROM archive_operations').get()?.n);
    if (count > 10000) backupFail();
    const operations: BackupOperation[] = [], owned: OwnedArchiveOperation[] = [], incompleteOperationIds: string[] = [];
    const objects = new Map<string, BackupObject>();
    for (const row of db.prepare('SELECT * FROM archive_operations ORDER BY id').all()) {
      const id = String(row.id), rootId = String(row.root_id);
      if (!isCollectionId(id) || !isCollectionId(rootId)) backupFail();
      if (row.phase !== 'FINALIZED' || row.issue !== null) { incompleteOperationIds.push(id); continue; }
      const value = JSON.parse(String(row.data)) as StoredArchiveOperation;
      const op = value.owned, request = value.request;
      if (!op || op.id !== id || request.id !== id || request.rootId !== rootId || op.archive.id !== rootId) backupFail();
      const manifest = archiveManifest(id, request.files, request.lineage);
      if (op.manifest !== manifest || archiveManifest(id, op.files, op.lineage) !== manifest || request.lineage.executionAssetId !== row.asset_id) backupFail();
      const rootRow = db.prepare('SELECT data FROM archive_roots WHERE id=?').get(rootId);
      if (!rootRow || archiveDigest(JSON.stringify(JSON.parse(String(rootRow.data)))) !== archiveDigest(JSON.stringify(op.archive))) backupFail();
      const assetRow = db.prepare('SELECT data FROM execution_assets WHERE id=?').get(row.asset_id!);
      if (!assetRow) backupFail();
      const asset = JSON.parse(String(assetRow.data)) as { masterVersionId: string; layoutVersionId: string };
      if (asset.masterVersionId !== request.lineage.masterVersionId || asset.layoutVersionId !== request.lineage.layoutVersionId) backupFail();
      const references = db.prepare('SELECT role,name,sha256,root_id FROM archive_references WHERE operation_id=?').all(id);
      if (references.length !== request.files.length) backupFail();
      for (const file of request.files) {
        const ref = references.find(r => r.role === file.role && r.name === file.name);
        const stored = db.prepare('SELECT size FROM archive_objects WHERE root_id=? AND sha256=?').get(rootId, file.sha256);
        if (!ref || ref.sha256 !== file.sha256 || ref.root_id !== rootId || stored?.size !== file.size) backupFail();
        const existing = objects.get(file.sha256);
        if (existing && existing.size !== file.size) backupFail();
        const entry = existing ?? { sha256: file.sha256, size: file.size, rootIds: [] };
        if (!entry.rootIds.includes(rootId)) entry.rootIds.push(rootId);
        objects.set(file.sha256, entry);
      }
      operations.push({ operationId: id, rootId, manifestHash: archiveDigest(manifest), manifestSize: Buffer.byteLength(manifest) }); owned.push(op);
    }
    // 有不完整操作时仅允许元数据备份；其内容引用不宣称已复制。
    if (!incompleteOperationIds.length) {
      const stored = db.prepare('SELECT root_id,sha256,size FROM archive_objects').all();
      if (stored.length !== [...objects.values()].reduce((n, o) => n + o.rootIds.length, 0)) backupFail();
      for (const row of stored) if (!objects.get(String(row.sha256))?.rootIds.includes(String(row.root_id))) backupFail();
    }
    return { index: { operations, objects: [...objects.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)).map(o => ({ ...o, rootIds: o.rootIds.sort() })), incompleteOperationIds }, owned };
  } finally { db.close(); }
}
