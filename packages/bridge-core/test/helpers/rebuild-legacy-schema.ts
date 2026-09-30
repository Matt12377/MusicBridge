import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** 固定旧表及旧列的事实投影；新增表不混入守恒比较，新增列由迁移专项断言验证。 */
export function historicalRows(db: DatabaseSync, version: 14 | 15 | 16 | 17 | 18 | 19 | 20): unknown[] {
  const fixed = new DatabaseSync(':memory:');
  try {
    fixed.exec(readFileSync(new URL(`../fixtures/collection-schema${version}${version === 20 ? '-completed' : ''}.sql`, import.meta.url), 'utf8'));
    return fixed.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      const table = String(name);
      const columns = fixed.prepare(`PRAGMA table_info("${table}")`).all().map(row => `"${String(row.name)}"`);
      return [table, db.prepare(`SELECT ${columns.join(',')} FROM "${table}" ORDER BY rowid`).all()];
    });
  } finally { fixed.close(); }
}

/** 只用于合成夹具：按固定历史 DDL 重建，保留历史已有列，拒绝残留新表伪装旧版本。 */
export function rebuildLegacySchema(db: DatabaseSync, version: 1 | 2 | 3 | 4 | 5 | 6 | 9 | 10 | 11 | 12 | 13 | 21 | 23): void {
  const sql = readFileSync(new URL(`../fixtures/collection-schema${version}-empty.sql`, import.meta.url), 'utf8');
  const historical = new DatabaseSync(':memory:');
  let tables: { name: string; columns: string[]; rows: Record<string, SQLInputValue>[] }[];
  try {
    historical.exec(sql);
    tables = historical.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map(({ name }) => {
      const table = String(name);
      const columns = historical.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name));
      return { name: table, columns, rows: db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM "${table}" ORDER BY rowid`).all() as Record<string, SQLInputValue>[] };
    });
  } finally { historical.close(); }
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    for (const type of ['trigger', 'view', 'table']) {
      for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type=? AND name NOT LIKE 'sqlite_%'").all(type)) {
        db.exec(`DROP ${type.toUpperCase()} "${String(row.name)}"`);
      }
    }
    db.exec(sql);
    for (const table of tables) {
      if (table.name === 'physical_sequences') db.exec('DELETE FROM physical_sequences');
      const insert = db.prepare(`INSERT INTO "${table.name}" (${table.columns.map(c => `"${c}"`).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`);
      for (const row of table.rows) insert.run(...table.columns.map(c => row[c]!));
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '固定历史夹具必须自身满足外键');
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, version);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}
