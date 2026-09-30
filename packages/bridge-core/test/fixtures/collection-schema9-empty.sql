-- 固定历史 DDL；来源 557cb78b（1–7）、a3d6274f（8）、62a20a6d（9–13）。

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

CREATE TABLE music_releases (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE legacy_recording_content (physical_id TEXT PRIMARY KEY REFERENCES physical_copies(physical_id), data TEXT NOT NULL) STRICT;
CREATE TABLE music_photos (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), content BLOB NOT NULL CHECK(length(content) BETWEEN 4 AND 1048576), content_hash TEXT NOT NULL, width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1200), height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1200), UNIQUE(release_id,content_hash)) STRICT;
CREATE TABLE music_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER music_ledger_no_update BEFORE UPDATE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER music_ledger_no_delete BEFORE DELETE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=3;

CREATE TABLE digital_albums (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), physical_absent INTEGER NOT NULL DEFAULT 0 CHECK(physical_absent IN (0,1))) STRICT;
CREATE TABLE physical_digital_links (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), digital_id TEXT NOT NULL REFERENCES digital_albums(id), relation TEXT NOT NULL CHECK(relation IN ('exact','probable','related')), rip_confirmed INTEGER NOT NULL CHECK(rip_confirmed IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0), UNIQUE(release_id,digital_id)) STRICT;
CREATE TABLE physical_digital_absence (release_id TEXT PRIMARY KEY REFERENCES music_releases(id), confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1))) STRICT;
CREATE TABLE physical_links_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER links_ledger_no_update BEFORE UPDATE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER links_ledger_no_delete BEFORE DELETE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=4;

CREATE TABLE master_drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL) STRICT;
CREATE TABLE master_drafts_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER drafts_ledger_no_update BEFORE UPDATE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER drafts_ledger_no_delete BEFORE DELETE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=5;

CREATE TABLE source_roots (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_bindings (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE draft_source_links (draft_id TEXT NOT NULL REFERENCES master_drafts(id),track_id TEXT NOT NULL,binding_id TEXT NOT NULL REFERENCES source_bindings(id),PRIMARY KEY(draft_id,track_id)) STRICT;
CREATE TABLE source_jobs (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER source_ledger_no_update BEFORE UPDATE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER source_ledger_no_delete BEFORE DELETE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=6;

CREATE TABLE media_plans (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE media_reservations (plan_id TEXT PRIMARY KEY REFERENCES media_plans(id),physical_id TEXT NOT NULL UNIQUE REFERENCES physical_copies(physical_id),data TEXT NOT NULL) STRICT;
CREATE TABLE media_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER media_ledger_no_update BEFORE UPDATE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER media_ledger_no_delete BEFORE DELETE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=7;

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

CREATE TABLE preparation_destinations (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_workspaces (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER preparation_workspaces_no_update BEFORE UPDATE ON preparation_workspaces BEGIN SELECT RAISE(ABORT,'immutable preparation'); END;
CREATE TRIGGER preparation_workspaces_no_delete BEFORE DELETE ON preparation_workspaces BEGIN SELECT RAISE(ABORT,'immutable preparation'); END;
CREATE TRIGGER preparation_ledger_no_update BEFORE UPDATE ON preparation_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER preparation_ledger_no_delete BEFORE DELETE ON preparation_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=9;
