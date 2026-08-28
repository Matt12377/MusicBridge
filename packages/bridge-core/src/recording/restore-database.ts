import { DatabaseSync } from 'node:sqlite';
import { backupFail } from './backup-files.js';

/** 只修改恢复目录内的独立副本；所有不可变版本/账本/旧路径事实原样保留。 */
export function isolateRestoredDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath, { allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    try {
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 14) backupFail();
      for (const table of ['source_roots', 'preparation_destinations']) db.exec(`UPDATE ${table} SET data=json_set(data,'$.authorized',json('false'))`);
      db.exec("UPDATE prepared_selections SET data=json_set(data,'$.root.authorized',json('false')); UPDATE archive_roots SET authorized=0; UPDATE archive_candidates SET authorized=0;");
      for (const table of ['source_jobs', 'version_jobs', 'preparation_jobs', 'prepared_jobs', 'execution_jobs']) {
        db.exec(`UPDATE ${table} SET data=json_set(data,'$.public.state','interrupted') WHERE json_extract(data,'$.public.state')='running'`);
      }
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) backupFail();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
export function verifyRestoredDatabaseIsolation(filePath: string): void {
  const db = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    for (const table of ['source_roots', 'preparation_destinations']) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE json_extract(data,'$.authorized') IS NOT 0 LIMIT 1`).get()) backupFail();
    }
    for (const table of ['archive_roots', 'archive_candidates']) if (db.prepare(`SELECT 1 FROM ${table} WHERE authorized<>0 LIMIT 1`).get()) backupFail();
    if (db.prepare("SELECT 1 FROM prepared_selections WHERE json_extract(data,'$.root.authorized') IS NOT 0 LIMIT 1").get()) backupFail();
    for (const table of ['source_jobs', 'version_jobs', 'preparation_jobs', 'prepared_jobs', 'execution_jobs']) if (db.prepare(`SELECT 1 FROM ${table} WHERE json_extract(data,'$.public.state')='running' LIMIT 1`).get()) backupFail();
  } finally { db.close(); }
}
