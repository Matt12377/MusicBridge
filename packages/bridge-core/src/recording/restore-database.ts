import { verifyMBQueueDatabase } from '../collection/mb-queue-store.js';
import { recoverRecordingPrints } from './print-store.js';
import { verifyRecordingRecordDatabase } from './record-integrity.js';
import { DatabaseSync } from 'node:sqlite';
import { backupFail } from './backup-files.js';
import { verifyRecordingAttemptDatabase } from './attempt-integrity.js';
import { recoverRecordingAttempts } from './attempt-store.js';
import { verifyRecordingWorkspaceDatabase } from './workspace-context-store.js';
import { verifyCommercialProvenanceDatabase } from '../collection/commercial-provenance.js';
import { verifyOutputRunBarrierDatabase } from './output-run-barrier.js';
import { revokePreparationZipForRestore, verifyPreparationZipDatabase, verifyPreparationZipSessionDatabase } from './preparation-export-store.js';
import { verifyRecordingRecordPageIndex, verifyRecordingRecordPageSearch } from './record-page-index.js';
import { verifyReferenceCatalogZipDatabase } from '../collection/reference-catalog-store.js';
import { verifyVersionDistributionDatabase } from './versions-store.js';
import { verifyLocalScanDatabase, recoverLocalScanJobs } from '../collection/local-scan-store.js';
import { verifyLocalCatalogDatabase } from '../collection/local-catalog-store.js';

/** 只修改恢复目录内的独立副本；所有不可变版本/账本/旧路径事实原样保留。 */
export function isolateRestoredDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath, { allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    const initialVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (!Number.isInteger(initialVersion) || initialVersion < 14 || initialVersion > 33) backupFail();
    verifyVersionDistributionDatabase(db);
    // 损坏历史必须在journal模式变更之前拒绝，连数据库文件头也不提前改写。
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 19) verifyRecordingAttemptDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 20) verifyRecordingRecordDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 22) verifyRecordingWorkspaceDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 24) verifyCommercialProvenanceDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 25) verifyOutputRunBarrierDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 26) verifyPreparationZipDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 27) verifyRecordingRecordPageIndex(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 28) verifyReferenceCatalogZipDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 29) verifyRecordingRecordPageSearch(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 30) verifyPreparationZipSessionDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 31) verifyLocalCatalogDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 32) verifyLocalScanDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 33) verifyMBQueueDatabase(db);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 14 && version !== 15 && version !== 16 && version !== 17 && version !== 18 && version !== 19 && version !== 20 && version !== 21 && version !== 22 && version !== 23 && version !== 24 && version !== 25 && version !== 26 && version !== 27 && version !== 28 && version !== 29 && version !== 30 && version !== 31 && version !== 32 && version !== 33) backupFail();
      if (Number(version) >= 19) { verifyRecordingAttemptDatabase(db); recoverRecordingAttempts(db, new Date().toISOString()); }
      if (Number(version) >= 25) verifyOutputRunBarrierDatabase(db);
      if (Number(version) >= 26) revokePreparationZipForRestore(db);
      if (Number(version) >= 21) recoverRecordingPrints(db);
      const publishScanAudit = Number(version) >= 32 ? recoverLocalScanJobs(db, 'restore') : undefined;
      for (const table of ['source_roots', 'preparation_destinations']) db.exec(`UPDATE ${table} SET data=json_set(data,'$.authorized',json('false'))`);
      db.exec("UPDATE prepared_selections SET data=json_set(data,'$.root.authorized',json('false')); UPDATE archive_roots SET authorized=0; UPDATE archive_candidates SET authorized=0;");
      for (const table of ['source_jobs', 'version_jobs', 'preparation_jobs', 'prepared_jobs', 'execution_jobs']) {
        db.exec(`UPDATE ${table} SET data=json_set(data,'$.public.state','interrupted') WHERE json_extract(data,'$.public.state')='running'`);
      }
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) backupFail();
      if (Number(version) >= 26) verifyPreparationZipDatabase(db);
      if (Number(version) >= 27) verifyRecordingRecordPageIndex(db);
      if (Number(version) >= 28) verifyReferenceCatalogZipDatabase(db);
      if (Number(version) >= 29) verifyRecordingRecordPageSearch(db);
      if (Number(version) >= 30) verifyPreparationZipSessionDatabase(db);
      if (Number(version) >= 31) verifyLocalCatalogDatabase(db);
      if (Number(version) >= 32) verifyLocalScanDatabase(db);
      if (Number(version) >= 33) verifyMBQueueDatabase(db);
      db.exec('COMMIT'); publishScanAudit?.();
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
export function verifyRestoredDatabaseIsolation(filePath: string): void {
  const db = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (!Number.isInteger(version) || version < 14 || version > 33) backupFail();
    verifyVersionDistributionDatabase(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 19) {
      verifyRecordingAttemptDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 20) verifyRecordingRecordDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 22) verifyRecordingWorkspaceDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 24) verifyCommercialProvenanceDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 25) verifyOutputRunBarrierDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 26) verifyPreparationZipDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 27) verifyRecordingRecordPageIndex(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 28) verifyReferenceCatalogZipDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 29) verifyRecordingRecordPageSearch(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 30) verifyPreparationZipSessionDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 31) verifyLocalCatalogDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 32) verifyLocalScanDatabase(db);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 33) verifyMBQueueDatabase(db);
      if (db.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress' LIMIT 1").get()) backupFail();
    }
    if (version >= 32 && db.prepare("SELECT 1 FROM local_scan_jobs WHERE json_extract(data,'$.phase')='running' LIMIT 1").get()) backupFail();
    for (const table of ['source_roots', 'preparation_destinations']) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE json_extract(data,'$.authorized') IS NOT 0 LIMIT 1`).get()) backupFail();
    }
    for (const table of ['archive_roots', 'archive_candidates']) if (db.prepare(`SELECT 1 FROM ${table} WHERE authorized<>0 LIMIT 1`).get()) backupFail();
    if (db.prepare("SELECT 1 FROM prepared_selections WHERE json_extract(data,'$.root.authorized') IS NOT 0 LIMIT 1").get()) backupFail();
    for (const table of ['source_jobs', 'version_jobs', 'preparation_jobs', 'prepared_jobs', 'execution_jobs']) if (db.prepare(`SELECT 1 FROM ${table} WHERE json_extract(data,'$.public.state')='running' LIMIT 1`).get()) backupFail();
  } finally { db.close(); }
}
