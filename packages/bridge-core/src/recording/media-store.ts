import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId, isMediaPlan, isSaveMediaPlanRequest, isReserveMediaRequest, isReleaseMediaRequest,
  type MediaPlan, type MediaReservation, type MediaTimingTrack, type MediaSourceBasis, type SaveMediaPlanRequest, type ReserveMediaRequest, type ReleaseMediaRequest, type Page, type PageRequest } from '@music-bridge/contracts';
import { resolveMediaLayout, assessMediaCandidate, type MediaStockCandidate } from './media-planner.js';
import type { StoredBinding } from './source-store.js';
import type { RootCapability } from './source-files.js';

export const mediaPlanningMigration = `
CREATE TABLE media_plans (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE media_reservations (plan_id TEXT PRIMARY KEY REFERENCES media_plans(id),physical_id TEXT NOT NULL UNIQUE REFERENCES physical_copies(physical_id),data TEXT NOT NULL) STRICT;
CREATE TABLE media_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER media_ledger_no_update BEFORE UPDATE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER media_ledger_no_delete BEFORE DELETE ON media_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=7;
`;
export interface MediaPlanningInput { draftId: string; revision: number; identity: string; fingerprint: string; tracks: readonly MediaTimingTrack[]; basis: MediaSourceBasis }
interface Access {
  read<T>(fn: (db: DatabaseSync) => T): T;
  conflict(message: string): never;
  unavailable(): never;
  beforeCommit?: (action: string) => void;
  stock(db: DatabaseSync, page: PageRequest, format: 'cassette' | 'dat'): Page<MediaStockCandidate>;
  stockOne(db: DatabaseSync, skuId: string, packaging: 'opened' | 'sealed'): MediaStockCandidate | undefined;
  reservationStock(db: DatabaseSync, reservation: MediaReservation): MediaStockCandidate | undefined;
  reserve(db: DatabaseSync, request: ReserveMediaRequest): MediaReservation;
  release(db: DatabaseSync, request: ReleaseMediaRequest, reservation: MediaReservation): void;
}
function canonical(value: unknown): string { return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value); }
export const mediaFingerprint = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export function createMediaPlanningStore(access: Access) {
  const { read, conflict, unavailable, beforeCommit } = access;
  function draft(db: DatabaseSync, id: string) {
    if (!isCollectionId(id)) return conflict('草稿编号无效。');
    const row = db.prepare('SELECT data,revision FROM master_drafts WHERE id=?').get(id);
    if (!row) return conflict('草稿不存在，请刷新。');
    return { data: JSON.parse(String(row.data)) as { tracks: { id: string }[] }, revision: Number(row.revision) };
  }
  function identity(db: DatabaseSync, draftId: string): string {
    const current = draft(db, draftId);
    const bindings = current.data.tracks.map(track => {
      const row = db.prepare('SELECT b.data FROM draft_source_links l JOIN source_bindings b ON b.id=l.binding_id WHERE l.draft_id=? AND l.track_id=?').get(draftId, track.id);
      if (!row) return { trackId: track.id };
      const binding = JSON.parse(String(row.data)) as StoredBinding;
      const root = db.prepare('SELECT data FROM source_roots WHERE id=?').get(binding.rootId);
      return { trackId: track.id, binding, root: root ? JSON.parse(String(root.data)) as RootCapability : null };
    });
    // 私有路径只参与单向摘要，不进入公开规划或日志。
    return mediaFingerprint({ draft: current, bindings });
  }
  function detail(db: DatabaseSync, id: string): MediaPlan {
    if (!isCollectionId(id)) return conflict('规划编号无效。');
    const row = db.prepare('SELECT data,revision FROM media_plans WHERE id=?').get(id);
    if (!row) return conflict('录音规划不存在。');
    const data = JSON.parse(String(row.data)) as Omit<MediaPlan, 'revision' | 'reservation' | 'requiresReview'>;
    const reservation = db.prepare('SELECT data FROM media_reservations WHERE plan_id=?').get(id);
    const result = { ...data, revision: Number(row.revision), requiresReview: draft(db, data.draftId).revision !== data.draftRevision, ...(reservation ? { reservation: JSON.parse(String(reservation.data)) as MediaReservation } : {}) };
    if (!isMediaPlan(result)) return unavailable(); return result;
  }
  function cached(db: DatabaseSync, commandId: string, fingerprint: string): string | undefined {
    const row = db.prepare('SELECT fingerprint,result FROM media_ledger WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同录音规划。');
    return String(row.result);
  }
  function transaction(action: string, request: { commandId: string }, fn: (db: DatabaseSync) => string): MediaPlan {
    return read(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const fingerprint = mediaFingerprint({ action, request }), prior = cached(db, request.commandId, fingerprint);
        if (prior) { const result = detail(db, prior); db.exec('COMMIT'); return result; }
        const id = fn(db), result = detail(db, id);
        db.prepare('INSERT INTO media_ledger VALUES (?,?,?,?)').run(request.commandId, fingerprint, id, new Date().toISOString());
        beforeCommit?.(action); db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  function assertInput(db: DatabaseSync, input: MediaPlanningInput): void {
    if (draft(db, input.draftId).revision !== input.revision || identity(db, input.draftId) !== input.identity) conflict('草稿或源绑定已改变，请重新计算并确认。');
  }
  return {
    inputIdentity(draftId: string): string { return read(db => identity(db, draftId)); },
    detail(id: string): MediaPlan { return read(db => detail(db, id)); },
    cached(action: string, request: { commandId: string }): MediaPlan | undefined { return read(db => { const id = cached(db, request.commandId, mediaFingerprint({ action, request })); return id ? detail(db, id) : undefined; }); },
    list(draftId: string) { return read(db => { draft(db, draftId); return { draftId, plans: db.prepare('SELECT id FROM media_plans WHERE draft_id=? ORDER BY rowid DESC LIMIT 100').all(draftId).map(row => detail(db, String(row.id))) }; }); },
    stock(page: PageRequest, format: 'cassette' | 'dat') { return read(db => access.stock(db, page, format)); },
    stockOne(skuId: string, packaging: 'opened' | 'sealed') { return read(db => access.stockOne(db, skuId, packaging)); },
    reservationStock(reservation: MediaReservation) { return read(db => access.reservationStock(db, reservation)); },
    save(request: SaveMediaPlanRequest, input: MediaPlanningInput): MediaPlan {
      if (!isSaveMediaPlanRequest(request)) return conflict('分面保存请求无效。');
      return transaction('save-media-plan', request, db => {
        assertInput(db, input);
        if (request.draftId !== input.draftId || request.expectedDraftRevision !== input.revision || request.inputFingerprint !== input.fingerprint) return conflict('分面预览已过期，请重新计算并确认。');
        const layout = resolveMediaLayout(input.tracks, request.spec);
        const id = request.planId ?? randomUUID();
        if (request.planId) { const current = detail(db, id); if (current.draftId !== request.draftId || current.revision !== request.expectedRevision) return conflict('规划已改变，请刷新后重新确认。'); }
        else if (Number(db.prepare('SELECT COUNT(*) n FROM media_plans WHERE draft_id=?').get(request.draftId)?.n) >= 100) return conflict('每份草稿最多保存 100 个规划。');
        const data = { id, draftId: request.draftId, draftRevision: input.revision, spec: request.spec, layout, sourceBasis: input.basis, inputFingerprint: input.fingerprint, executionReady: false as const };
        db.prepare('INSERT INTO media_plans VALUES (?,?,?,1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=media_plans.revision+1').run(id, request.draftId, JSON.stringify(data));
        return id;
      });
    },
    reserve(request: ReserveMediaRequest, input: MediaPlanningInput): MediaPlan {
      if (!isReserveMediaRequest(request)) return conflict('预留请求无效或未明确确认。');
      return transaction('reserve-media-plan', request, db => {
        const current = detail(db, request.planId); assertInput(db, input);
        if (current.revision !== request.expectedRevision || current.draftId !== input.draftId || current.inputFingerprint !== input.fingerprint) return conflict('规划或源数据已变化，请重新保存确认后预留。');
        if (current.reservation) return conflict('此规划已有预留，请先明确取消原预留。');
        const stock = access.stockOne(db, request.skuId, request.packaging);
        if (!stock || assessMediaCandidate(stock, current.layout, current.spec, input.basis).status !== 'recommended') return conflict('库存、容量、兼容性或收藏保护条件不再满足。');
        const reservation = access.reserve(db, request);
        db.prepare('INSERT INTO media_reservations VALUES (?,?,?)').run(current.id, reservation.physicalId, JSON.stringify(reservation));
        db.prepare('UPDATE media_plans SET revision=revision+1 WHERE id=?').run(current.id);
        return current.id;
      });
    },
    release(request: ReleaseMediaRequest): MediaPlan {
      if (!isReleaseMediaRequest(request)) return conflict('取消预留需要明确确认。');
      return transaction('release-media-plan', request, db => {
        const current = detail(db, request.planId);
        if (current.revision !== request.expectedRevision || !current.reservation) return conflict('预留状态已改变，请刷新。');
        access.release(db, request, current.reservation);
        db.prepare('DELETE FROM media_reservations WHERE plan_id=?').run(current.id);
        db.prepare('UPDATE media_plans SET revision=revision+1 WHERE id=?').run(current.id);
        return current.id;
      });
    },
  };
}
export type MediaPlanningStore = ReturnType<typeof createMediaPlanningStore>;
