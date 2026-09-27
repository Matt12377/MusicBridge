import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// 冻结历史 DDL，不从待测的当前迁移或 sqlite_master 反推旧库结构。
// schema 1–2: 557cb78bf1048732bb30638de6440368787bda0d
// packages/bridge-core/src/collection/repository.ts, blob e1f2716f98afa1f6e4fbfcbc279054569cad45a2
const collectionSchema = `
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

// schema 3: 557cb78bf1048732bb30638de6440368787bda0d
// packages/bridge-core/src/collection/physical-music.ts, blob 13f3f830d70135f3474cf9ded82c8703ba0857de
const physicalMusicSchema = `
CREATE TABLE music_releases (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE legacy_recording_content (physical_id TEXT PRIMARY KEY REFERENCES physical_copies(physical_id), data TEXT NOT NULL) STRICT;
CREATE TABLE music_photos (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), content BLOB NOT NULL CHECK(length(content) BETWEEN 4 AND 1048576), content_hash TEXT NOT NULL, width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1200), height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1200), UNIQUE(release_id,content_hash)) STRICT;
CREATE TABLE music_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER music_ledger_no_update BEFORE UPDATE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER music_ledger_no_delete BEFORE DELETE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=3;
`;

// schema 4: 557cb78bf1048732bb30638de6440368787bda0d
// packages/bridge-core/src/collection/physical-links.ts, blob 3e3f8eab7ec5c7f357990e621469b7b045814d95
const physicalLinksSchema = `
CREATE TABLE digital_albums (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), physical_absent INTEGER NOT NULL DEFAULT 0 CHECK(physical_absent IN (0,1))) STRICT;
CREATE TABLE physical_digital_links (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), digital_id TEXT NOT NULL REFERENCES digital_albums(id), relation TEXT NOT NULL CHECK(relation IN ('exact','probable','related')), rip_confirmed INTEGER NOT NULL CHECK(rip_confirmed IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0), UNIQUE(release_id,digital_id)) STRICT;
CREATE TABLE physical_digital_absence (release_id TEXT PRIMARY KEY REFERENCES music_releases(id), confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1))) STRICT;
CREATE TABLE physical_links_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER links_ledger_no_update BEFORE UPDATE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER links_ledger_no_delete BEFORE DELETE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=4;
`;

// schema 5: 557cb78bf1048732bb30638de6440368787bda0d
// packages/bridge-core/src/recording/drafts.ts, blob 200d128cc7c7f33f91ea47395bb9817c714c485f
const draftsSchema = `
CREATE TABLE master_drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL) STRICT;
CREATE TABLE master_drafts_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER drafts_ledger_no_update BEFORE UPDATE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER drafts_ledger_no_delete BEFORE DELETE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=5;
`;

// schema 6: 557cb78bf1048732bb30638de6440368787bda0d
// packages/bridge-core/src/recording/source-store.ts, blob cc9cd1f71864cb12bdbcc956bb28f0905405a903
const sourceSchema = `
CREATE TABLE source_roots (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_bindings (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE draft_source_links (draft_id TEXT NOT NULL REFERENCES master_drafts(id),track_id TEXT NOT NULL,binding_id TEXT NOT NULL REFERENCES source_bindings(id),PRIMARY KEY(draft_id,track_id)) STRICT;
CREATE TABLE source_jobs (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER source_ledger_no_update BEFORE UPDATE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER source_ledger_no_delete BEFORE DELETE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=6;
`;

// schema 7: 557cb78bf1048732bb30638de6440368787bda0d
// packages/bridge-core/src/recording/media-store.ts, blob 6ced1dfa4de8f5bc56227500391d108b34479190
const mediaSchema = `
CREATE TABLE media_plans (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE media_reservations (plan_id TEXT PRIMARY KEY REFERENCES media_plans(id),physical_id TEXT NOT NULL UNIQUE REFERENCES physical_copies(physical_id),data TEXT NOT NULL) STRICT;
CREATE TABLE media_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER media_ledger_no_update BEFORE UPDATE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER media_ledger_no_delete BEFORE DELETE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=7;
`;

// schema 8: a3d6274f21181ed10d01a83cc820552a976bc58f
// packages/bridge-core/src/recording/versions-store.ts, blob 3e2496ba4744d094c6f4f3aef184d358eb08c064
const versionsSchema = `
CREATE TABLE master_versions (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE layout_versions (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),master_id TEXT NOT NULL REFERENCES master_versions(id),data TEXT NOT NULL) STRICT;
CREATE TABLE version_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE version_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER master_versions_no_update BEFORE UPDATE ON master_versions BEGIN SELECT RAISE(ABORT,'immutable master'); END;
CREATE TRIGGER master_versions_no_delete BEFORE DELETE ON master_versions BEGIN SELECT RAISE(ABORT,'immutable master'); END;
CREATE TRIGGER layout_versions_no_update BEFORE UPDATE ON layout_versions BEGIN SELECT RAISE(ABORT,'immutable layout'); END;
CREATE TRIGGER layout_versions_no_delete BEFORE DELETE ON layout_versions BEGIN SELECT RAISE(ABORT,'immutable layout'); END;
CREATE TRIGGER version_ledger_no_update BEFORE UPDATE ON version_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER version_ledger_no_delete BEFORE DELETE ON version_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=8;
`;

// 仅从合成的当前库取旧版本已有的列；新增列和当前 sqlite_master 不参与旧库构造。
const legacyColumns = [
  ['collection_models', 'id', 'identity_key', 'descriptor', 'policy', 'minimum_sealed', 'revision'],
  ['collection_skus', 'id', 'model_id', 'minutes'],
  ['inventory_lots', 'id', 'sku_id', 'acquired', 'sealed', 'opened', 'legacy', 'unknown'],
  ['physical_sequences', 'format', 'next_value'],
  ['physical_copies', 'physical_id', 'lot_id', 'packaging', 'usage', 'available', 'origin', 'revision', 'reserved_from'],
  ['inventory_ledger', 'command_id', 'fingerprint', 'action', 'result', 'event_data', 'created_at'],
  ['collection_photos', 'id', 'model_id', 'physical_id', 'content', 'content_hash', 'width', 'height'],
  ['collection_featured_photos', 'model_id', 'photo_id'],
  ['music_releases', 'id', 'data', 'revision'],
  ['legacy_recording_content', 'physical_id', 'data'],
  ['music_photos', 'id', 'release_id', 'content', 'content_hash', 'width', 'height'],
  ['music_ledger', 'command_id', 'fingerprint', 'action', 'result', 'created_at'],
  ['digital_albums', 'id', 'metadata', 'revision', 'physical_absent'],
  ['physical_digital_links', 'id', 'release_id', 'digital_id', 'relation', 'rip_confirmed', 'revision'],
  ['physical_digital_absence', 'release_id', 'confirmed'],
  ['physical_links_ledger', 'command_id', 'fingerprint', 'result', 'created_at'],
  ['master_drafts', 'id', 'data', 'revision', 'updated_at'],
  ['master_drafts_ledger', 'command_id', 'fingerprint', 'result', 'created_at'],
  ['source_roots', 'id', 'data'],
  ['source_bindings', 'id', 'data'],
  ['draft_source_links', 'draft_id', 'track_id', 'binding_id'],
  ['source_jobs', 'id', 'data'],
  ['source_ledger', 'command_id', 'fingerprint', 'result', 'created_at'],
  ['media_plans', 'id', 'draft_id', 'data', 'revision'],
  ['media_reservations', 'plan_id', 'physical_id', 'data'],
  ['media_ledger', 'command_id', 'fingerprint', 'result', 'created_at'],
] as const;
const versionColumns = [
  ['master_versions', 'id', 'draft_id', 'data'],
  ['layout_versions', 'id', 'draft_id', 'master_id', 'data'],
  ['version_jobs', 'id', 'draft_id', 'data'],
  ['version_ledger', 'command_id', 'fingerprint', 'result', 'created_at'],
] as const;

function tables(version: 7 | 8) { return version === 7 ? legacyColumns : [...legacyColumns, ...versionColumns]; }

export function createLegacyDatabase(filePath: string, version: 7 | 8, syntheticCurrentPath: string): void {
  const old = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  const current = new DatabaseSync(syntheticCurrentPath, { readOnly: true });
  try {
    old.exec(collectionSchema + physicalMusicSchema + physicalLinksSchema + draftsSchema + sourceSchema + mediaSchema + (version === 8 ? versionsSchema : ''));
    old.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, ...columns] of tables(version)) {
        if (table === 'physical_sequences') old.exec('DELETE FROM physical_sequences');
        const selected = current.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all();
        const insert = old.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of selected) insert.run(...columns.map(column => row[column]) as SQLInputValue[]);
      }
      old.exec('COMMIT');
    } catch (error) { old.exec('ROLLBACK'); throw error; }
  } finally { current.close(); old.close(); }
}

export function snapshotLegacyDatabase(filePath: string, version: 7 | 8) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return {
      version: Number(db.prepare('PRAGMA user_version').get()?.user_version),
      schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      rows: tables(version).map(([table, ...columns]) => [table, db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all()] as const),
    };
  } finally { db.close(); }
}
