import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isCollectionId, isRecordingProfileVersion, isRecordingSessionSettings, isSaveRecordingProfileRequest, isSaveRecordingSessionRequest, effectiveRecordingSettings, type RecordingProfileVersion, type RecordingProfileHistory, type SaveRecordingProfileRequest, type SaveRecordingSessionRequest, type RecordingSessionSettings, type ResolvedRecordingSettings } from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';

export const recordingProfilesMigration = `
CREATE TABLE recording_profiles (id TEXT PRIMARY KEY,current_version_id TEXT NOT NULL REFERENCES recording_profile_versions(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE recording_profile_versions (id TEXT PRIMARY KEY,profile_id TEXT NOT NULL REFERENCES recording_profiles(id),sequence INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(profile_id,sequence)) STRICT;
CREATE TABLE recording_sessions (draft_id TEXT PRIMARY KEY REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE recording_profile_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER recording_profile_versions_no_update BEFORE UPDATE ON recording_profile_versions BEGIN SELECT RAISE(ABORT,'immutable recording profile'); END;
CREATE TRIGGER recording_profile_versions_no_delete BEFORE DELETE ON recording_profile_versions BEGIN SELECT RAISE(ABORT,'immutable recording profile'); END;
CREATE TRIGGER recording_profile_ledger_no_update BEFORE UPDATE ON recording_profile_ledger BEGIN SELECT RAISE(ABORT,'immutable recording profile ledger'); END;
CREATE TRIGGER recording_profile_ledger_no_delete BEFORE DELETE ON recording_profile_ledger BEGIN SELECT RAISE(ABORT,'immutable recording profile ledger'); END;
PRAGMA user_version=11;
`;
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void }
export function createRecordingProfilesStore({ read, conflict, beforeCommit }: Access) {
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T { return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  function parseVersion(value: unknown): RecordingProfileVersion {
    const parsed: unknown = JSON.parse(String(value));
    if (!isRecordingProfileVersion(parsed) || mediaFingerprint(parsed.content) !== parsed.contentHash) return conflict('录音参数版本缺失或损坏。');
    return parsed;
  }
  function version(db: DatabaseSync, id: string): RecordingProfileVersion {
    if (!isCollectionId(id)) return conflict('录音参数版本编号无效。');
    const row = db.prepare('SELECT data FROM recording_profile_versions WHERE id=?').get(id);
    return row ? parseVersion(row.data) : conflict('录音参数版本不存在。');
  }
  function receipt<T>(db: DatabaseSync, id: string, fingerprint: string): T | undefined {
    const row = db.prepare('SELECT fingerprint,result FROM recording_profile_ledger WHERE command_id=?').get(id);
    if (row && row.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同的录音参数请求。');
    return row ? JSON.parse(String(row.result)) as T : undefined;
  }
  function record(db: DatabaseSync, id: string, fingerprint: string, result: unknown): void { db.prepare('INSERT INTO recording_profile_ledger VALUES (?,?,?,?)').run(id, fingerprint, JSON.stringify(result), new Date().toISOString()); }
  function session(db: DatabaseSync, draftId: string): RecordingSessionSettings | null {
    if (!isCollectionId(draftId) || !db.prepare('SELECT id FROM master_drafts WHERE id=?').get(draftId)) return conflict('录音草稿不存在。');
    const row = db.prepare('SELECT data FROM recording_sessions WHERE draft_id=?').get(draftId);
    if (!row) return null; const value: unknown = JSON.parse(String(row.data));
    if (!isRecordingSessionSettings(value) || value.draftId !== draftId) return conflict('本次录音参数损坏。');
    return value;
  }
  return {
    list(): { profiles: readonly RecordingProfileVersion[] } { return read(db => ({ profiles: db.prepare('SELECT v.data FROM recording_profiles p JOIN recording_profile_versions v ON v.id=p.current_version_id ORDER BY v.rowid DESC').all().map(row => parseVersion(row.data)) })); },
    version: (id: string): RecordingProfileVersion => read(db => version(db, id)),
    history(id: string): RecordingProfileHistory {
      return read(db => {
        if (!isCollectionId(id) || !db.prepare('SELECT id FROM recording_profiles WHERE id=?').get(id)) return conflict('录音参数模板不存在。');
        return { profileId: id, versions: db.prepare('SELECT data FROM recording_profile_versions WHERE profile_id=? ORDER BY sequence DESC').all(id).map(row => parseVersion(row.data)) };
      });
    },
    save(request: SaveRecordingProfileRequest): RecordingProfileVersion {
      if (!isSaveRecordingProfileRequest(request)) return conflict('请检查并明确确认录音参数。');
      return transaction('save-recording-profile', db => {
        const fp = mediaFingerprint(['save-profile', request]), prior = receipt<RecordingProfileVersion>(db, request.commandId, fp); if (prior) return prior;
        const profileId = request.profileId ?? randomUUID(); let previous: RecordingProfileVersion | undefined;
        if (request.profileId) {
          const current = db.prepare('SELECT current_version_id FROM recording_profiles WHERE id=?').get(profileId);
          if (!current || current.current_version_id !== request.expectedVersionId) return conflict('录音参数已由其他操作更新，请刷新后再保存。');
          previous = version(db, String(current.current_version_id));
          if (previous.sequence >= 100) return conflict('此录音参数模板已达到 100 个版本，请建立新模板。');
        } else if (Number(db.prepare('SELECT count(*) AS n FROM recording_profiles').get()!.n) >= 100) return conflict('录音参数模板已达到 100 个，请复用已有模板。');
        const content = structuredClone(request.content), value: RecordingProfileVersion = { id: randomUUID(), profileId, sequence: previous ? previous.sequence + 1 : 1, ...(previous ? { parentVersionId: previous.id } : {}), createdAt: new Date().toISOString(), content, contentHash: mediaFingerprint(content) };
        if (!previous) db.prepare('INSERT INTO recording_profiles VALUES (?,?)').run(profileId, value.id);
        db.prepare('INSERT INTO recording_profile_versions VALUES (?,?,?,?)').run(value.id, profileId, value.sequence, JSON.stringify(value));
        if (previous) db.prepare('UPDATE recording_profiles SET current_version_id=? WHERE id=?').run(value.id, profileId);
        record(db, request.commandId, fp, value); return value;
      });
    },
    session: (draftId: string): { session: RecordingSessionSettings | null } => read(db => ({ session: session(db, draftId) })),
    saveSession(request: SaveRecordingSessionRequest): RecordingSessionSettings {
      if (!isSaveRecordingSessionRequest(request)) return conflict('请检查并明确确认本次录音参数。');
      return transaction('save-recording-session', db => {
        const fp = mediaFingerprint(['save-session', request]), prior = receipt<RecordingSessionSettings>(db, request.commandId, fp); if (prior) return prior;
        const current = session(db, request.draftId); version(db, request.profileVersionId);
        if ((current?.revision ?? 0) !== request.expectedRevision) return conflict('本次录音参数已改变，请刷新后再确认。');
        const value: RecordingSessionSettings = { draftId: request.draftId, revision: (current?.revision ?? 0) + 1, profileVersionId: request.profileVersionId, overrides: structuredClone(request.overrides), updatedAt: new Date().toISOString() };
        db.prepare('INSERT INTO recording_sessions VALUES (?,?) ON CONFLICT(draft_id) DO UPDATE SET data=excluded.data').run(value.draftId, JSON.stringify(value)); record(db, request.commandId, fp, value); return value;
      });
    },
    resolve(settings: RecordingSessionSettings): ResolvedRecordingSettings {
      if (!isRecordingSessionSettings(settings)) return conflict('本次录音参数无效。');
      return read(db => {
        const profile = version(db, settings.profileVersionId), overrides = structuredClone(settings.overrides), effective = effectiveRecordingSettings(profile, overrides), format = { ...profile.content.executionFormat, outputProfileVersion: profile.id };
        return { profile, overrides, effective, format, fingerprint: mediaFingerprint({ profile, overrides, effective, format }) };
      });
    },
  };
}
export type RecordingProfilesStore = ReturnType<typeof createRecordingProfilesStore>;
