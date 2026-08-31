-- TASK068 固定旧 schema14 合成夹具。
-- 由 base b95ef2c26dc0bdbf89c64d8c99f79ad8f2b4a83a 原 repository 生成；不含真实库存。
PRAGMA foreign_keys=OFF;
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
CREATE TABLE collection_photos (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES collection_models(id),
  physical_id TEXT REFERENCES physical_copies(physical_id),
  content BLOB NOT NULL CHECK(length(content) BETWEEN 4 AND 1048576),
  content_hash TEXT NOT NULL, width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1200),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1200)
) STRICT;
CREATE TABLE collection_featured_photos (
  model_id TEXT PRIMARY KEY REFERENCES collection_models(id),
  photo_id TEXT NOT NULL REFERENCES collection_photos(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE music_releases (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE legacy_recording_content (physical_id TEXT PRIMARY KEY REFERENCES physical_copies(physical_id), data TEXT NOT NULL) STRICT;
CREATE TABLE music_photos (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), content BLOB NOT NULL CHECK(length(content) BETWEEN 4 AND 1048576), content_hash TEXT NOT NULL, width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1200), height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1200), UNIQUE(release_id,content_hash)) STRICT;
CREATE TABLE music_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE digital_albums (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), physical_absent INTEGER NOT NULL DEFAULT 0 CHECK(physical_absent IN (0,1))) STRICT;
CREATE TABLE physical_digital_links (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), digital_id TEXT NOT NULL REFERENCES digital_albums(id), relation TEXT NOT NULL CHECK(relation IN ('exact','probable','related')), rip_confirmed INTEGER NOT NULL CHECK(rip_confirmed IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0), UNIQUE(release_id,digital_id)) STRICT;
CREATE TABLE physical_digital_absence (release_id TEXT PRIMARY KEY REFERENCES music_releases(id), confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1))) STRICT;
CREATE TABLE physical_links_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE master_drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL) STRICT;
CREATE TABLE master_drafts_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE source_roots (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_bindings (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE draft_source_links (draft_id TEXT NOT NULL REFERENCES master_drafts(id),track_id TEXT NOT NULL,binding_id TEXT NOT NULL REFERENCES source_bindings(id),PRIMARY KEY(draft_id,track_id)) STRICT;
CREATE TABLE source_jobs (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE media_plans (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE media_reservations (plan_id TEXT PRIMARY KEY REFERENCES media_plans(id),physical_id TEXT NOT NULL UNIQUE REFERENCES physical_copies(physical_id),data TEXT NOT NULL) STRICT;
CREATE TABLE media_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE master_versions (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE layout_versions (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),master_id TEXT NOT NULL REFERENCES master_versions(id),data TEXT NOT NULL) STRICT;
CREATE TABLE version_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE version_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE preparation_destinations (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_workspaces (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE prepared_versions (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE prepared_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE prepared_selections (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE prepared_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE recording_profiles (id TEXT PRIMARY KEY,current_version_id TEXT NOT NULL REFERENCES recording_profile_versions(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE recording_profile_versions (id TEXT PRIMARY KEY,profile_id TEXT NOT NULL REFERENCES recording_profiles(id),sequence INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(profile_id,sequence)) STRICT;
CREATE TABLE recording_sessions (draft_id TEXT PRIMARY KEY REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE recording_profile_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE execution_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE execution_assets (id TEXT PRIMARY KEY REFERENCES execution_jobs(id),draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE execution_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE archive_roots(id TEXT PRIMARY KEY,data TEXT NOT NULL,authorized INTEGER NOT NULL CHECK(authorized IN (0,1))) STRICT;
CREATE TABLE archive_operations(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES archive_roots(id),asset_id TEXT NOT NULL REFERENCES execution_assets(id),fingerprint TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('REQUESTED','INTENT_WRITTEN','STAGED','VERIFIED','PROMOTED','DB_COMMITTED','FINALIZED')),data TEXT NOT NULL,issue TEXT CHECK(issue IS NULL OR issue IN ('ARCHIVE_RECOVERY_REQUIRED','ARCHIVE_ROOT_INVALID','ARCHIVE_DISK_FULL','CANCELLED'))) STRICT;
CREATE TABLE archive_objects(root_id TEXT NOT NULL REFERENCES archive_roots(id),sha256 TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>0),PRIMARY KEY(root_id,sha256)) STRICT;
CREATE TABLE archive_references(operation_id TEXT NOT NULL REFERENCES archive_operations(id),root_id TEXT NOT NULL,role TEXT NOT NULL,name TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(operation_id,role,name),FOREIGN KEY(root_id,sha256) REFERENCES archive_objects(root_id,sha256)) STRICT;
CREATE TABLE archive_candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL,authorized INTEGER NOT NULL CHECK(authorized IN (0,1))) STRICT;
CREATE TABLE archive_workflow_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_id TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
INSERT INTO "collection_models" VALUES('e3c4e1b3-c7d0-403a-bdee-fe9e000cece3','72c34ad7923abee7e9e361073f0997ac3b7cacb24f90f5f057f0e817faf165db','{"brand":"合成品牌","name":"固定旧库型号","edition":"1990","year":1990,"format":"cassette","tapeType":"II","identification":"verified"}','normal',0,2);
INSERT INTO "collection_skus" VALUES('141ac317-1345-4a78-b514-80b20656a001','e3c4e1b3-c7d0-403a-bdee-fe9e000cece3',90);
INSERT INTO "inventory_lots" VALUES('b3a67df2-d2c1-4411-aad6-23eab7ed8c2b','141ac317-1345-4a78-b514-80b20656a001',5,2,2,0,0);
INSERT INTO "physical_sequences" VALUES('cassette',2);
INSERT INTO "physical_sequences" VALUES('dat',1);
INSERT INTO "physical_copies" VALUES('MB-C-00001','b3a67df2-d2c1-4411-aad6-23eab7ed8c2b','opened','blank',1,'blank-pool',1,NULL);
INSERT INTO "inventory_ledger" VALUES('11111111-1111-4111-8111-111111111111','1008dc88a77314cbcc0731fc73f5ee1e2f2cda00668228ac45439b9f9510d740','receive','{"modelId":"e3c4e1b3-c7d0-403a-bdee-fe9e000cece3","lotId":"b3a67df2-d2c1-4411-aad6-23eab7ed8c2b"}','{"kind":"RECEIVE","quantityAcquired":5,"quantities":{"sealedBlank":3,"openedBlank":2,"legacyUsed":0,"unclassified":0}}','2026-08-28T10:09:33.755Z');
INSERT INTO "inventory_ledger" VALUES('22222222-2222-4222-8222-222222222222','31f95ba29fc0e52362e82697bc39553ce0d9bfdc5f7ae966a280c4715851fe61','materialize','{"modelId":"e3c4e1b3-c7d0-403a-bdee-fe9e000cece3","lotId":"b3a67df2-d2c1-4411-aad6-23eab7ed8c2b","physicalId":"MB-C-00001"}','{"kind":"POOL_TO_COPY","bucket":"sealedBlank","before":3,"after":2,"packaging":"opened","usage":"blank","origin":"blank-pool"}','2026-08-28T10:09:33.756Z');
INSERT INTO "inventory_ledger" VALUES('33333333-3333-4333-8333-333333333333','4ad5ce74852922d39531ca4e2ff055f11cb9f908c2f7404ba0143fd5e88b361c','add-photo','{"modelId":"e3c4e1b3-c7d0-403a-bdee-fe9e000cece3","photoId":"2260162b-9512-45f6-8b4b-fbe2f5d5b252"}','{"kind":"PHOTO_ADDED","hash":"32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af","physicalId":null}','2026-08-28T10:09:33.757Z');
INSERT INTO "collection_photos" VALUES('2260162b-9512-45f6-8b4b-fbe2f5d5b252','e3c4e1b3-c7d0-403a-bdee-fe9e000cece3',NULL,X'ffd8ffd9','32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af',1,1);
CREATE INDEX inventory_lots_sku ON inventory_lots(sku_id);
CREATE INDEX physical_copies_lot ON physical_copies(lot_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON inventory_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON inventory_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE UNIQUE INDEX collection_photo_identity ON collection_photos(model_id,COALESCE(physical_id,''),content_hash);
CREATE TRIGGER music_ledger_no_update BEFORE UPDATE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER music_ledger_no_delete BEFORE DELETE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER links_ledger_no_update BEFORE UPDATE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER links_ledger_no_delete BEFORE DELETE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER drafts_ledger_no_update BEFORE UPDATE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER drafts_ledger_no_delete BEFORE DELETE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER source_ledger_no_update BEFORE UPDATE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER source_ledger_no_delete BEFORE DELETE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER media_ledger_no_update BEFORE UPDATE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER media_ledger_no_delete BEFORE DELETE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER master_versions_no_update BEFORE UPDATE ON master_versions BEGIN SELECT RAISE(ABORT,'immutable master'); END;
CREATE TRIGGER master_versions_no_delete BEFORE DELETE ON master_versions BEGIN SELECT RAISE(ABORT,'immutable master'); END;
CREATE TRIGGER layout_versions_no_update BEFORE UPDATE ON layout_versions BEGIN SELECT RAISE(ABORT,'immutable layout'); END;
CREATE TRIGGER layout_versions_no_delete BEFORE DELETE ON layout_versions BEGIN SELECT RAISE(ABORT,'immutable layout'); END;
CREATE TRIGGER version_ledger_no_update BEFORE UPDATE ON version_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER version_ledger_no_delete BEFORE DELETE ON version_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER preparation_workspaces_no_update BEFORE UPDATE ON preparation_workspaces BEGIN SELECT RAISE(ABORT,'immutable preparation'); END;
CREATE TRIGGER preparation_workspaces_no_delete BEFORE DELETE ON preparation_workspaces BEGIN SELECT RAISE(ABORT,'immutable preparation'); END;
CREATE TRIGGER preparation_ledger_no_update BEFORE UPDATE ON preparation_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER preparation_ledger_no_delete BEFORE DELETE ON preparation_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER prepared_versions_no_update BEFORE UPDATE ON prepared_versions BEGIN SELECT RAISE(ABORT,'immutable prepared'); END;
CREATE TRIGGER prepared_versions_no_delete BEFORE DELETE ON prepared_versions BEGIN SELECT RAISE(ABORT,'immutable prepared'); END;
CREATE TRIGGER prepared_ledger_no_update BEFORE UPDATE ON prepared_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER prepared_ledger_no_delete BEFORE DELETE ON prepared_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER prepared_jobs_completed_no_update BEFORE UPDATE ON prepared_jobs WHEN json_extract(OLD.data,'$.public.state')='completed' BEGIN SELECT RAISE(ABORT,'immutable original render'); END;
CREATE TRIGGER prepared_jobs_no_delete BEFORE DELETE ON prepared_jobs BEGIN SELECT RAISE(ABORT,'immutable import history'); END;
CREATE TRIGGER recording_profile_versions_no_update BEFORE UPDATE ON recording_profile_versions BEGIN SELECT RAISE(ABORT,'immutable recording profile'); END;
CREATE TRIGGER recording_profile_versions_no_delete BEFORE DELETE ON recording_profile_versions BEGIN SELECT RAISE(ABORT,'immutable recording profile'); END;
CREATE TRIGGER recording_profile_ledger_no_update BEFORE UPDATE ON recording_profile_ledger BEGIN SELECT RAISE(ABORT,'immutable recording profile ledger'); END;
CREATE TRIGGER recording_profile_ledger_no_delete BEFORE DELETE ON recording_profile_ledger BEGIN SELECT RAISE(ABORT,'immutable recording profile ledger'); END;
CREATE TRIGGER execution_assets_no_update BEFORE UPDATE ON execution_assets BEGIN SELECT RAISE(ABORT,'immutable execution asset'); END;
CREATE TRIGGER execution_assets_no_delete BEFORE DELETE ON execution_assets BEGIN SELECT RAISE(ABORT,'immutable execution asset'); END;
CREATE TRIGGER execution_ledger_no_update BEFORE UPDATE ON execution_ledger BEGIN SELECT RAISE(ABORT,'immutable execution ledger'); END;
CREATE TRIGGER execution_ledger_no_delete BEFORE DELETE ON execution_ledger BEGIN SELECT RAISE(ABORT,'immutable execution ledger'); END;
CREATE TRIGGER execution_jobs_completed_no_update BEFORE UPDATE ON execution_jobs WHEN json_extract(OLD.data,'$.public.state')='completed' BEGIN SELECT RAISE(ABORT,'immutable completed execution'); END;
CREATE TRIGGER execution_jobs_no_delete BEFORE DELETE ON execution_jobs BEGIN SELECT RAISE(ABORT,'immutable execution history'); END;
CREATE TRIGGER archive_roots_identity BEFORE UPDATE OF id,data ON archive_roots BEGIN SELECT RAISE(ABORT,'归档目录身份不可改写'); END;
CREATE TRIGGER archive_operations_identity BEFORE UPDATE OF id,root_id,asset_id,fingerprint ON archive_operations BEGIN SELECT RAISE(ABORT,'归档意图不可改写'); END;
CREATE TRIGGER archive_operations_data BEFORE UPDATE OF data ON archive_operations WHEN OLD.phase<>'REQUESTED' BEGIN SELECT RAISE(ABORT,'归档操作内容不可改写'); END;
CREATE TRIGGER archive_operations_no_delete BEFORE DELETE ON archive_operations BEGIN SELECT RAISE(ABORT,'归档历史不可删除'); END;
CREATE TRIGGER archive_objects_no_update BEFORE UPDATE ON archive_objects BEGIN SELECT RAISE(ABORT,'归档对象不可改写或删除'); END;
CREATE TRIGGER archive_objects_no_delete BEFORE DELETE ON archive_objects BEGIN SELECT RAISE(ABORT,'归档对象不可改写或删除'); END;
CREATE TRIGGER archive_references_no_update BEFORE UPDATE ON archive_references BEGIN SELECT RAISE(ABORT,'归档引用不可改写或删除'); END;
CREATE TRIGGER archive_references_no_delete BEFORE DELETE ON archive_references BEGIN SELECT RAISE(ABORT,'归档引用不可改写或删除'); END;
CREATE TRIGGER archive_workflow_ledger_no_update BEFORE UPDATE ON archive_workflow_ledger BEGIN SELECT RAISE(ABORT,'归档操作账本不可改写'); END;
CREATE TRIGGER archive_workflow_ledger_no_delete BEFORE DELETE ON archive_workflow_ledger BEGIN SELECT RAISE(ABORT,'归档操作账本不可删除'); END;
PRAGMA user_version=14;
PRAGMA foreign_keys=ON;
