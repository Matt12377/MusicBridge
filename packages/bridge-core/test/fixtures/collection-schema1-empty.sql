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