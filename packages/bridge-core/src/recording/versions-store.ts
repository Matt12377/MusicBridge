import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId } from '@music-bridge/contracts';

export const masterVersionsMigration = `
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
import { randomUUID } from 'node:crypto';
import type { VersionHistory, VersionProposal, FreezeVersionsRequest, VersionJob, VersionFailure, MasterVersion, LayoutVersion, MediaPlan, SourceBinding } from '@music-bridge/contracts';
import { mediaFingerprint, type MediaPlanningStore } from './media-store.js';
import { assessMediaCandidate } from './media-planner.js';
export interface VersionInput { identity: string; plan: MediaPlan; stockFingerprint: string; title: string; proposal: VersionProposal; sourceEvidence: readonly { trackId: string; binding: SourceBinding }[] }
export interface StoredVersionJob { public: VersionJob; request: FreezeVersionsRequest; input: VersionInput }
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; media: MediaPlanningStore; beforeCommit?: (action: string) => void }
export function createMasterVersionsStore({ read, conflict, media, beforeCommit }: Access) {
  const job = (db: DatabaseSync, id: string): StoredVersionJob | undefined => { const row = db.prepare('SELECT data FROM version_jobs WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) as StoredVersionJob : undefined; };
  const saveJob = (db: DatabaseSync, job: StoredVersionJob): void => { db.prepare('INSERT INTO version_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.public.id, job.public.draftId, JSON.stringify(job)); };
  function list(db: DatabaseSync, draftId: string): VersionHistory {
    if (!isCollectionId(draftId) || !db.prepare('SELECT id FROM master_drafts WHERE id=?').get(draftId)) return conflict('草稿不存在，请刷新。');
    const rows = <T>(table: string): T[] => db.prepare(`SELECT data FROM ${table} WHERE draft_id=? ORDER BY rowid DESC`).all(draftId).map(r => JSON.parse(String(r.data)) as T);
    return { draftId, masters: rows<MasterVersion>('master_versions'), layouts: rows<LayoutVersion>('layout_versions'), jobs: rows<StoredVersionJob>('version_jobs').map(j => j.public) };
  }
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  function receipt(db: DatabaseSync, commandId: string, fingerprint: string): string | undefined {
    const row = db.prepare('SELECT fingerprint,result FROM version_ledger WHERE command_id=?').get(commandId);
    if (row && row.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同版本操作。');
    return row ? String(row.result) : undefined;
  }
  function record(db: DatabaseSync, commandId: string, fingerprint: string, result: string): void { db.prepare('INSERT INTO version_ledger VALUES (?,?,?,?)').run(commandId, fingerprint, result, new Date().toISOString()); }
  function assertInput(db: DatabaseSync, input: VersionInput): void {
    const current = media.detail(input.plan.id), stock = current.reservation ? media.reservationStock(current.reservation) : undefined;
    const history = list(db, current.draftId), previous = history.masters[0]?.id;
    if (media.inputIdentity(current.draftId) !== input.identity || mediaFingerprint(current) !== mediaFingerprint(input.plan) || !stock || mediaFingerprint(stock) !== input.stockFingerprint || current.requiresReview || assessMediaCandidate(stock, current.layout, current.spec, current.sourceBasis).status !== 'recommended' || previous !== input.proposal.previousMasterId) return conflict('草稿、源、分面、版本历史或预留已改变，请重新预览。');
  }
  return {
    list(draftId: string): VersionHistory { return read(db => list(db, draftId)); },
    job(id: string): StoredVersionJob | undefined { return read(db => job(db, id)); },
    cached(request: FreezeVersionsRequest): VersionJob | undefined { return read(db => { const prior = receipt(db, request.commandId, mediaFingerprint(['freeze', request])); return prior ? job(db, prior)?.public : undefined; }); },
    start(request: FreezeVersionsRequest, input: VersionInput): StoredVersionJob {
      return transaction('start-version-freeze', db => {
        const fingerprint = mediaFingerprint(['freeze', request]), prior = receipt(db, request.commandId, fingerprint);
        if (prior) return job(db, prior) ?? conflict('版本任务记录缺失。');
        assertInput(db, input);
        const history = list(db, input.plan.draftId);
        if (history.jobs.some(j => j.state === 'running')) return conflict('此草稿已有冻结复核在进行。');
        if (history.masters.length >= 100 || history.layouts.length >= 100 || history.jobs.length >= 1000) return conflict('此草稿版本或任务历史已达上限，请建立新草稿。');
        const result: StoredVersionJob = { request, input, public: { id: request.commandId, draftId: input.plan.draftId, planId: request.planId, state: 'running' } };
        saveJob(db, result); record(db, request.commandId, fingerprint, request.commandId); return result;
      });
    },
    finish(id: string, sourceEvidence: VersionInput['sourceEvidence']): VersionJob {
      return transaction('freeze-master-versions', db => {
        const current = job(db, id) ?? conflict('版本任务不存在。'); if (current.public.state !== 'running') return current.public;
        const input = current.input; assertInput(db, input);
        const history = list(db, input.plan.draftId), createdAt = new Date().toISOString();
        let master = history.masters.find(m => m.contentHash === input.proposal.contentHash);
        if (!master) {
          master = { id: randomUUID(), draftId: input.plan.draftId, sequence: history.masters.length + 1, ...(history.masters[0] ? { parentId: history.masters[0].id } : {}), title: input.title, createdAt, content: input.proposal.content, contentHash: input.proposal.contentHash, sourceEvidence, status: 'frozen' };
          db.prepare('INSERT INTO master_versions VALUES (?,?,?)').run(master.id, master.draftId, JSON.stringify(master));
        }
        const layout: LayoutVersion = { id: randomUUID(), draftId: input.plan.draftId, masterVersionId: master.id, sequence: history.layouts.length + 1, ...(history.layouts[0] ? { parentId: history.layouts[0].id } : {}), planId: input.plan.id, createdAt, spec: input.plan.spec, lengthMinutes: input.proposal.lengthMinutes, reservation: input.proposal.reservation, timeline: input.proposal.timeline, timelineHash: input.proposal.timelineHash, status: 'frozen', executionReady: false };
        db.prepare('INSERT INTO layout_versions VALUES (?,?,?,?)').run(layout.id, layout.draftId, master.id, JSON.stringify(layout));
        current.public = { ...current.public, state: 'completed', masterVersionId: master.id, layoutVersionId: layout.id }; saveJob(db, current);
        record(db, randomUUID(), mediaFingerprint(['frozen', id]), JSON.stringify({ masterVersionId: master.id, layoutVersionId: layout.id, sourceEvidence }));
        return current.public;
      });
    },
    fail(id: string, failure: VersionFailure): VersionJob {
      return transaction('fail-version-freeze', db => { const current = job(db, id) ?? conflict('版本任务不存在。'); if (current.public.state === 'running') { current.public = { ...current.public, state: failure === 'CANCELLED' ? 'cancelled' : 'failed', failure }; saveJob(db, current); } return current.public; });
    },
    cancel(request: { commandId: string; id: string }): VersionJob {
      return transaction('cancel-version-freeze', db => {
        const fingerprint = mediaFingerprint(['cancel', request.id]), prior = receipt(db, request.commandId, fingerprint);
        const current = job(db, request.id) ?? conflict('版本任务不存在。');
        if (!prior) { if (current.public.state === 'running') { current.public = { ...current.public, state: 'cancelled', failure: 'CANCELLED' }; saveJob(db, current); } record(db, request.commandId, fingerprint, request.id); }
        return current.public;
      });
    },
    recover(): void { transaction('interrupt-version-jobs', db => { for (const row of db.prepare('SELECT data FROM version_jobs').all()) { const current = JSON.parse(String(row.data)) as StoredVersionJob; if (current.public.state === 'running') { current.public = { ...current.public, state: 'interrupted' }; saveJob(db, current); } } }); },
  };
}
export type MasterVersionsStore = ReturnType<typeof createMasterVersionsStore>;
