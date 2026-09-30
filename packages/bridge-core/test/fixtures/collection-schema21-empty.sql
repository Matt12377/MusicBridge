-- 空历史 DDL；schema21：05256eb；schema22/23：6d6c1c4 的正式迁移。
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
CREATE TABLE physical_sequences (format TEXT PRIMARY KEY, next_value INTEGER NOT NULL CHECK(next_value > 0)) STRICT;
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
CREATE TABLE reference_sources(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,pack_hash TEXT NOT NULL,raw_pack TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(book_id,pack_hash)) STRICT;
CREATE TABLE reference_catalog_revisions(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES reference_sources(id),sequence INTEGER NOT NULL,previous_id TEXT REFERENCES reference_catalog_revisions(id),data TEXT NOT NULL,UNIQUE(book_id,sequence)) STRICT;
CREATE TABLE reference_catalog_heads(book_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id)) STRICT;
CREATE TABLE reference_catalog_matches(revision_id TEXT PRIMARY KEY REFERENCES reference_catalog_revisions(id),version INTEGER NOT NULL CHECK(version>=0),data TEXT NOT NULL) STRICT;
CREATE TABLE reference_catalog_snapshots(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),match_version INTEGER NOT NULL CHECK(match_version>=0),data TEXT NOT NULL) STRICT;
CREATE TABLE reference_catalog_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE "inventory_lots" (
 id TEXT PRIMARY KEY,sku_id TEXT NOT NULL REFERENCES collection_skus(id),
 acquired INTEGER NOT NULL CHECK(acquired BETWEEN 1 AND 10000),
 sealed INTEGER NOT NULL CHECK(sealed>=0),opened INTEGER NOT NULL CHECK(opened>=0),
 legacy INTEGER NOT NULL CHECK(legacy>=0),unknown INTEGER NOT NULL CHECK(unknown>=0),
 quantity_adjustment INTEGER NOT NULL DEFAULT 0 CHECK(quantity_adjustment BETWEEN -1000000 AND 1000000),
 CHECK(acquired+quantity_adjustment BETWEEN 0 AND 1000000),
 CHECK(sealed+opened+legacy+unknown<=acquired+quantity_adjustment)
) STRICT;
CREATE TABLE spreadsheet_sources(id TEXT PRIMARY KEY,workbook_hash TEXT NOT NULL UNIQUE,bytes BLOB NOT NULL,data TEXT NOT NULL) STRICT;
CREATE TABLE spreadsheet_source_rows(source_id TEXT NOT NULL REFERENCES spreadsheet_sources(id),sheet_name TEXT NOT NULL,row_index INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source_id,sheet_name,row_index)) STRICT;
CREATE TABLE spreadsheet_revisions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES spreadsheet_sources(id),sheet_name TEXT NOT NULL,previous_id TEXT REFERENCES spreadsheet_revisions(id),lineage_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(source_id,sheet_name)) STRICT;
CREATE TABLE spreadsheet_heads(lineage_id TEXT PRIMARY KEY,current_id TEXT NOT NULL REFERENCES spreadsheet_revisions(id)) STRICT;
CREATE TABLE spreadsheet_rows(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES spreadsheet_revisions(id),row_index INTEGER NOT NULL,effect_id TEXT REFERENCES spreadsheet_effects(id),data TEXT NOT NULL,UNIQUE(revision_id,row_index)) STRICT;
CREATE TABLE spreadsheet_effects(id TEXT PRIMARY KEY,lot_id TEXT NOT NULL UNIQUE REFERENCES inventory_lots(id),model_id TEXT NOT NULL REFERENCES collection_models(id),command_id TEXT NOT NULL UNIQUE REFERENCES inventory_ledger(command_id),quantity INTEGER NOT NULL,legacy INTEGER NOT NULL,unknown INTEGER NOT NULL) STRICT;
CREATE TABLE spreadsheet_adjustments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES spreadsheet_revisions(id),row_id TEXT NOT NULL REFERENCES spreadsheet_rows(id),effect_id TEXT NOT NULL REFERENCES spreadsheet_effects(id),legacy_delta INTEGER NOT NULL,unknown_delta INTEGER NOT NULL,data TEXT NOT NULL) STRICT;
CREATE TABLE spreadsheet_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE collection_wants(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),data TEXT NOT NULL) STRICT;
CREATE TABLE collection_want_events(id TEXT NOT NULL REFERENCES collection_wants(id),version INTEGER NOT NULL CHECK(version>0),revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),command_id TEXT NOT NULL UNIQUE REFERENCES collection_progress_ledger(command_id) DEFERRABLE INITIALLY DEFERRED,data TEXT NOT NULL,PRIMARY KEY(id,version)) STRICT;
CREATE TABLE collection_progress_snapshots(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),match_version INTEGER NOT NULL CHECK(match_version>=0),command_id TEXT NOT NULL UNIQUE REFERENCES collection_progress_ledger(command_id) DEFERRABLE INITIALLY DEFERRED,data TEXT NOT NULL) STRICT;
CREATE TABLE collection_progress_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE recording_plan_versions(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),sequence INTEGER NOT NULL,parent_id TEXT REFERENCES recording_plan_versions(id),asset_id TEXT NOT NULL REFERENCES execution_assets(id),archive_id TEXT NOT NULL REFERENCES archive_operations(id),physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),data TEXT NOT NULL,UNIQUE(draft_id,sequence)) STRICT;
CREATE TABLE recording_plan_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,plan_id TEXT NOT NULL UNIQUE REFERENCES recording_plan_versions(id)) STRICT;
CREATE TABLE recording_attempts(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES recording_plan_versions(id),draft_id TEXT NOT NULL REFERENCES master_drafts(id),physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),status TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),data TEXT NOT NULL) STRICT;
CREATE TABLE recording_attempt_events(attempt_id TEXT NOT NULL REFERENCES recording_attempts(id) DEFERRABLE INITIALLY DEFERRED,revision INTEGER NOT NULL CHECK(revision>0),kind TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(attempt_id,revision)) STRICT;
CREATE TABLE recording_attempt_receipts(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,attempt_id TEXT NOT NULL,revision INTEGER NOT NULL,result TEXT NOT NULL,FOREIGN KEY(attempt_id,revision) REFERENCES recording_attempt_events(attempt_id,revision)) STRICT;
CREATE TABLE "physical_copies" (
  physical_id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  packaging TEXT NOT NULL CHECK(packaging IN ('sealed','opened','unknown')),
  usage TEXT NOT NULL CHECK(usage IN ('blank','reserved','recorded','unknown','erased')),
  available INTEGER NOT NULL CHECK(available IN (0,1)),
  origin TEXT NOT NULL CHECK(origin IN ('blank-pool','legacy-registration','unclassified')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), reserved_from TEXT,
  CHECK((usage='reserved' AND reserved_from IN ('blank','erased','recorded','unknown')) OR (usage<>'reserved' AND reserved_from IS NULL))
) STRICT;
CREATE TABLE recording_records(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,attempt_revision INTEGER NOT NULL,physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),plan_id TEXT NOT NULL REFERENCES recording_plan_versions(id),data TEXT NOT NULL,FOREIGN KEY(attempt_id,attempt_revision) REFERENCES recording_attempt_events(attempt_id,revision)) STRICT;
CREATE TABLE recording_record_current(physical_id TEXT PRIMARY KEY REFERENCES physical_copies(physical_id),revision INTEGER NOT NULL,data TEXT NOT NULL,event_hash TEXT NOT NULL) STRICT;
CREATE TABLE recording_record_events(physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),revision INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(physical_id,revision)) STRICT;
CREATE TABLE recording_record_permits(id TEXT NOT NULL,revision INTEGER NOT NULL,physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),state TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,revision)) STRICT;
CREATE TABLE recording_record_receipts(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
CREATE TABLE recording_record_visuals(sha256 TEXT PRIMARY KEY,content BLOB NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL) STRICT;
CREATE TABLE recording_record_write_guard(physical_id TEXT PRIMARY KEY,action TEXT NOT NULL) STRICT;
CREATE TABLE recording_print_objects(sha256 TEXT PRIMARY KEY,mime TEXT NOT NULL,content BLOB NOT NULL,width INTEGER,height INTEGER) STRICT;
CREATE TABLE master_artwork_versions(id TEXT PRIMARY KEY,master_id TEXT NOT NULL REFERENCES master_versions(id),sequence INTEGER NOT NULL,sha256 TEXT NOT NULL REFERENCES recording_print_objects(sha256),data TEXT NOT NULL,UNIQUE(master_id,sequence)) STRICT;
CREATE TABLE master_artwork_current(master_id TEXT PRIMARY KEY REFERENCES master_versions(id),version_id TEXT NOT NULL UNIQUE REFERENCES master_artwork_versions(id)) STRICT;
CREATE TABLE recording_print_requests(id TEXT PRIMARY KEY,recording_id TEXT NOT NULL UNIQUE REFERENCES recording_records(id),data TEXT NOT NULL,facts TEXT NOT NULL) STRICT;
CREATE TABLE recording_print_jobs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES recording_print_requests(id),data TEXT NOT NULL,lease TEXT) STRICT;
CREATE TABLE recording_print_events(job_id TEXT NOT NULL REFERENCES recording_print_jobs(id),revision INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(job_id,revision)) STRICT;
CREATE TABLE recording_print_artifacts(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES recording_print_requests(id),pdf_sha TEXT NOT NULL REFERENCES recording_print_objects(sha256),preview_sha TEXT NOT NULL REFERENCES recording_print_objects(sha256),data TEXT NOT NULL) STRICT;
CREATE TABLE recording_print_receipts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX collection_photo_identity ON collection_photos(model_id,COALESCE(physical_id,''),content_hash);
CREATE INDEX inventory_lots_sku ON inventory_lots(sku_id);
CREATE INDEX spreadsheet_rows_revision ON spreadsheet_rows(revision_id);
CREATE INDEX spreadsheet_rows_effect ON spreadsheet_rows(effect_id);
CREATE INDEX spreadsheet_revisions_lineage ON spreadsheet_revisions(lineage_id);
CREATE INDEX spreadsheet_adjustments_effect ON spreadsheet_adjustments(effect_id);
CREATE UNIQUE INDEX recording_attempt_one_active ON recording_attempts(status) WHERE status='in-progress';
CREATE INDEX physical_copies_lot ON physical_copies(lot_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON inventory_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON inventory_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
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
CREATE TRIGGER reference_sources_no_update BEFORE UPDATE ON reference_sources BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER reference_sources_no_delete BEFORE DELETE ON reference_sources BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER reference_catalog_revisions_no_update BEFORE UPDATE ON reference_catalog_revisions BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER reference_catalog_revisions_no_delete BEFORE DELETE ON reference_catalog_revisions BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER reference_catalog_snapshots_no_update BEFORE UPDATE ON reference_catalog_snapshots BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER reference_catalog_snapshots_no_delete BEFORE DELETE ON reference_catalog_snapshots BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER reference_catalog_ledger_no_update BEFORE UPDATE ON reference_catalog_ledger BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER reference_catalog_ledger_no_delete BEFORE DELETE ON reference_catalog_ledger BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END;
CREATE TRIGGER spreadsheet_acquired_immutable BEFORE UPDATE OF acquired ON inventory_lots WHEN NEW.acquired<>OLD.acquired BEGIN SELECT RAISE(ABORT,'immutable acquired quantity'); END;
CREATE TRIGGER spreadsheet_sources_no_update BEFORE UPDATE ON spreadsheet_sources BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_sources_no_delete BEFORE DELETE ON spreadsheet_sources BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_source_rows_no_update BEFORE UPDATE ON spreadsheet_source_rows BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_source_rows_no_delete BEFORE DELETE ON spreadsheet_source_rows BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_revisions_no_update BEFORE UPDATE ON spreadsheet_revisions BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_revisions_no_delete BEFORE DELETE ON spreadsheet_revisions BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_rows_no_update BEFORE UPDATE ON spreadsheet_rows BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_rows_no_delete BEFORE DELETE ON spreadsheet_rows BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_effects_no_update BEFORE UPDATE ON spreadsheet_effects BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_effects_no_delete BEFORE DELETE ON spreadsheet_effects BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_adjustments_no_update BEFORE UPDATE ON spreadsheet_adjustments BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_adjustments_no_delete BEFORE DELETE ON spreadsheet_adjustments BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_ledger_no_update BEFORE UPDATE ON spreadsheet_ledger BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER spreadsheet_ledger_no_delete BEFORE DELETE ON spreadsheet_ledger BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END;
CREATE TRIGGER collection_want_events_no_update BEFORE UPDATE ON collection_want_events BEGIN SELECT RAISE(ABORT,'immutable collection progress'); END;
CREATE TRIGGER collection_want_events_no_delete BEFORE DELETE ON collection_want_events BEGIN SELECT RAISE(ABORT,'immutable collection progress'); END;
CREATE TRIGGER collection_progress_snapshots_no_update BEFORE UPDATE ON collection_progress_snapshots BEGIN SELECT RAISE(ABORT,'immutable collection progress'); END;
CREATE TRIGGER collection_progress_snapshots_no_delete BEFORE DELETE ON collection_progress_snapshots BEGIN SELECT RAISE(ABORT,'immutable collection progress'); END;
CREATE TRIGGER collection_progress_ledger_no_update BEFORE UPDATE ON collection_progress_ledger BEGIN SELECT RAISE(ABORT,'immutable collection progress'); END;
CREATE TRIGGER collection_progress_ledger_no_delete BEFORE DELETE ON collection_progress_ledger BEGIN SELECT RAISE(ABORT,'immutable collection progress'); END;
CREATE TRIGGER collection_wants_no_delete BEFORE DELETE ON collection_wants BEGIN SELECT RAISE(ABORT,'immutable want identity'); END;
CREATE TRIGGER recording_plan_versions_no_update BEFORE UPDATE ON recording_plan_versions BEGIN SELECT RAISE(ABORT,'录音计划版本不可改写'); END;
CREATE TRIGGER recording_plan_versions_no_delete BEFORE DELETE ON recording_plan_versions BEGIN SELECT RAISE(ABORT,'录音计划版本不可删除'); END;
CREATE TRIGGER recording_plan_ledger_no_update BEFORE UPDATE ON recording_plan_ledger BEGIN SELECT RAISE(ABORT,'录音计划账本不可改写'); END;
CREATE TRIGGER recording_plan_ledger_no_delete BEFORE DELETE ON recording_plan_ledger BEGIN SELECT RAISE(ABORT,'录音计划账本不可删除'); END;
CREATE TRIGGER recording_attempt_events_no_update BEFORE UPDATE ON recording_attempt_events BEGIN SELECT RAISE(ABORT,'录音事件不可改写'); END;
CREATE TRIGGER recording_attempt_events_no_delete BEFORE DELETE ON recording_attempt_events BEGIN SELECT RAISE(ABORT,'录音事件不可删除'); END;
CREATE TRIGGER recording_attempt_receipts_no_update BEFORE UPDATE ON recording_attempt_receipts BEGIN SELECT RAISE(ABORT,'录音命令回执不可改写'); END;
CREATE TRIGGER recording_attempt_receipts_no_delete BEFORE DELETE ON recording_attempt_receipts BEGIN SELECT RAISE(ABORT,'录音命令回执不可删除'); END;
CREATE TRIGGER recording_attempts_no_delete BEFORE DELETE ON recording_attempts BEGIN SELECT RAISE(ABORT,'录音历史不可删除'); END;
CREATE TRIGGER recording_attempt_active_media_no_update BEFORE UPDATE ON media_plans WHEN EXISTS(SELECT 1 FROM recording_attempts a JOIN recording_plan_versions p ON p.id=a.plan_id WHERE a.status='in-progress' AND json_extract(p.data,'$.layout.planId')=OLD.id) BEGIN SELECT RAISE(ABORT,'活动录音的媒体规划不可修改'); END;
CREATE TRIGGER recording_attempt_copy_no_blank BEFORE UPDATE OF usage ON physical_copies WHEN NEW.usage<>OLD.usage AND EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体状态须经明确处置'); END;
CREATE TRIGGER recording_attempt_reservation_no_delete BEFORE DELETE ON media_reservations WHEN EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体占用须经明确处置'); END;
CREATE TRIGGER recording_attempt_reservation_no_rebind BEFORE UPDATE ON media_reservations WHEN EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体占用不可自动改绑'); END;
CREATE TRIGGER recording_records_no_update BEFORE UPDATE ON recording_records BEGIN SELECT RAISE(ABORT,'录音档案历史不可改写'); END;
CREATE TRIGGER recording_records_no_delete BEFORE DELETE ON recording_records BEGIN SELECT RAISE(ABORT,'录音档案历史不可删除'); END;
CREATE TRIGGER recording_record_events_no_update BEFORE UPDATE ON recording_record_events BEGIN SELECT RAISE(ABORT,'录音档案历史不可改写'); END;
CREATE TRIGGER recording_record_events_no_delete BEFORE DELETE ON recording_record_events BEGIN SELECT RAISE(ABORT,'录音档案历史不可删除'); END;
CREATE TRIGGER recording_record_permits_no_update BEFORE UPDATE ON recording_record_permits BEGIN SELECT RAISE(ABORT,'录音档案历史不可改写'); END;
CREATE TRIGGER recording_record_permits_no_delete BEFORE DELETE ON recording_record_permits BEGIN SELECT RAISE(ABORT,'录音档案历史不可删除'); END;
CREATE TRIGGER recording_record_receipts_no_update BEFORE UPDATE ON recording_record_receipts BEGIN SELECT RAISE(ABORT,'录音档案历史不可改写'); END;
CREATE TRIGGER recording_record_receipts_no_delete BEFORE DELETE ON recording_record_receipts BEGIN SELECT RAISE(ABORT,'录音档案历史不可删除'); END;
CREATE TRIGGER recording_record_visuals_no_update BEFORE UPDATE ON recording_record_visuals BEGIN SELECT RAISE(ABORT,'录音档案历史不可改写'); END;
CREATE TRIGGER recording_record_visuals_no_delete BEFORE DELETE ON recording_record_visuals BEGIN SELECT RAISE(ABORT,'录音档案历史不可删除'); END;
CREATE TRIGGER recording_record_current_no_delete BEFORE DELETE ON recording_record_current BEGIN SELECT RAISE(ABORT,'当前内容历史不可删除'); END;
CREATE TRIGGER recording_record_permit_media_guard BEFORE UPDATE ON media_plans WHEN EXISTS(SELECT 1 FROM recording_record_permits p WHERE json_extract(p.data,'$.mediaPlanId')=OLD.id AND p.state='available' AND NOT EXISTS(SELECT 1 FROM recording_record_permits q WHERE q.id=p.id AND q.revision>p.revision) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard g WHERE g.physical_id=p.physical_id)) BEGIN SELECT RAISE(ABORT,'重录许可的目标规划不可自动改版'); END;
CREATE TRIGGER recording_record_content_copy_guard BEFORE UPDATE OF usage ON physical_copies WHEN NEW.usage<>OLD.usage AND EXISTS(SELECT 1 FROM recording_record_current WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'已有内容认知的实体须经明确处置'); END;
CREATE TRIGGER recording_record_permit_copy_guard BEFORE UPDATE ON physical_copies WHEN EXISTS(SELECT 1 FROM recording_record_permits p WHERE p.physical_id=OLD.physical_id AND p.state='available' AND NOT EXISTS(SELECT 1 FROM recording_record_permits q WHERE q.id=p.id AND q.revision>p.revision)) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'重录许可尚未处置'); END;
CREATE TRIGGER master_artwork_versions_no_update BEFORE UPDATE ON master_artwork_versions BEGIN SELECT RAISE(ABORT,'印刷历史不可改写'); END;
CREATE TRIGGER master_artwork_versions_no_delete BEFORE DELETE ON master_artwork_versions BEGIN SELECT RAISE(ABORT,'印刷历史不可删除'); END;
CREATE TRIGGER recording_print_objects_no_update BEFORE UPDATE ON recording_print_objects BEGIN SELECT RAISE(ABORT,'印刷历史不可改写'); END;
CREATE TRIGGER recording_print_objects_no_delete BEFORE DELETE ON recording_print_objects BEGIN SELECT RAISE(ABORT,'印刷历史不可删除'); END;
CREATE TRIGGER recording_print_requests_no_update BEFORE UPDATE ON recording_print_requests BEGIN SELECT RAISE(ABORT,'印刷历史不可改写'); END;
CREATE TRIGGER recording_print_requests_no_delete BEFORE DELETE ON recording_print_requests BEGIN SELECT RAISE(ABORT,'印刷历史不可删除'); END;
CREATE TRIGGER recording_print_events_no_update BEFORE UPDATE ON recording_print_events BEGIN SELECT RAISE(ABORT,'印刷历史不可改写'); END;
CREATE TRIGGER recording_print_events_no_delete BEFORE DELETE ON recording_print_events BEGIN SELECT RAISE(ABORT,'印刷历史不可删除'); END;
CREATE TRIGGER recording_print_artifacts_no_update BEFORE UPDATE ON recording_print_artifacts BEGIN SELECT RAISE(ABORT,'印刷历史不可改写'); END;
CREATE TRIGGER recording_print_artifacts_no_delete BEFORE DELETE ON recording_print_artifacts BEGIN SELECT RAISE(ABORT,'印刷历史不可删除'); END;
CREATE TRIGGER recording_print_receipts_no_update BEFORE UPDATE ON recording_print_receipts BEGIN SELECT RAISE(ABORT,'印刷历史不可改写'); END;
CREATE TRIGGER recording_print_receipts_no_delete BEFORE DELETE ON recording_print_receipts BEGIN SELECT RAISE(ABORT,'印刷历史不可删除'); END;
CREATE TRIGGER master_artwork_current_no_delete BEFORE DELETE ON master_artwork_current BEGIN SELECT RAISE(ABORT,'印刷当前投影不可删除'); END;
CREATE TRIGGER recording_print_jobs_no_delete BEFORE DELETE ON recording_print_jobs BEGIN SELECT RAISE(ABORT,'印刷当前投影不可删除'); END;
PRAGMA user_version=21;
