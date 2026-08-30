import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { parseRecordingPlan } from './plan-integrity.js';
import { recordFail } from './record-integrity.js';
import { recordingRecordSummary } from './record-projections.js';
import { createRecordingDispositionService } from './record-disposition.js';
import type { RecordingRecordStore } from './record-store.js';

interface Options { store: RecordingRecordStore; assertCurrent: () => void; assertExecutionIdle: () => void }
function plan(db: DatabaseSync, id: string): dto.RecordingPlanVersion {
  const row = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(id);
  if (!row) return recordFail('IO_ERROR'); return parseRecordingPlan(row.data);
}
const includes = (value: string, query?: string) => query === undefined || value.toLowerCase().includes(query.toLowerCase());
function physicalAliases(query: string): string[] | undefined {
  const match = /^(?:(MB-)?([CD])-)?(\d{1,9})$/u.exec(query);
  if (!match || Number(match[3]) < 1) return undefined;
  const suffix = String(Number(match[3])).padStart(5, '0');
  return (match[2] ? [match[2]] : ['C', 'D']).map(format => `MB-${format}-${suffix}`);
}
function matches(record: dto.RecordingRecord, frozen: dto.RecordingPlanVersion, summary: dto.RecordingRecordSummary, filter: dto.RecordingRecordFilter): boolean {
  const tracks = frozen.master.content.tracks.map(track => track.metadata.title).join(' ');
  const artists = frozen.master.content.tracks.map(track => track.metadata.artist ?? '').join(' ');
  const equipment = frozen.profileSnapshot.settings.effective.signalChain.map(step => step.label).join(' ');
  if (filter.physicalId && summary.physicalId !== filter.physicalId || filter.masterVersionId && frozen.master.id !== filter.masterVersionId
    || !includes(tracks, filter.track) || !includes(artists, filter.artist) || !includes(summary.title, filter.master) || !includes(summary.mediaBrand, filter.mediaBrand)
    || !includes(summary.mediaSeries, filter.mediaSeries) || !includes(equipment, filter.equipment)
    || filter.completedFrom && summary.completedAt < filter.completedFrom || filter.completedTo && summary.completedAt > filter.completedTo) return false;
  if (filter.query) {
    const aliases = physicalAliases(filter.query);
    if (aliases) return aliases.includes(record.completion.physicalId);
    return includes([summary.physicalId, summary.title, tracks, artists, summary.mediaBrand, summary.mediaSeries, equipment, summary.completedAt].join(' '), filter.query);
  }
  return true;
}

/** 只提供档案读取和显式人工处置；不持有音频driver，不自动登记或播放。 */
export function createRecordingRecordCoordinator({ store, assertCurrent, assertExecutionIdle }: Options) {
  let closed = false;
  const open = () => { if (closed) return recordFail('CLOSED'); assertCurrent(); };
  const dispositions = createRecordingDispositionService(store, () => { try { assertExecutionIdle(); } catch { return recordFail('NOT_READY'); } });
  return {
    list(request: dto.ListRecordingRecordsRequest): dto.RecordingRecordsPage {
      open(); if (!dto.isListRecordingRecordsRequest(request)) return recordFail('INVALID_REQUEST');
      return store.read(db => {
        // 上限由record store完整性/预算守护；只保存本页摘要，不将整批Plan装入返回值。
        const items: dto.RecordingRecordSummary[] = []; let total = 0;
        for (const row of db.prepare("SELECT id,plan_id FROM recording_records ORDER BY json_extract(data,'$.completion.endedAt') DESC,id DESC").iterate()) {
          const record = store.record(db, String(row.id)) ?? recordFail('IO_ERROR'), frozen = plan(db, String(row.plan_id)), summary = recordingRecordSummary(record, frozen);
          if (!matches(record, frozen, summary, request.filter ?? {})) continue;
          if (total >= request.page.offset && items.length < request.page.limit) items.push(summary); ++total;
        }
        const result = { items, ...request.page, total, hasMore: request.page.offset + items.length < total };
        if (!dto.isRecordingRecordsPage(result)) return recordFail('IO_ERROR'); return result;
      });
    },
    get(request: dto.RecordingRecordIdRequest): { record: dto.RecordingRecordDetail | null } {
      open(); if (!dto.isRecordingRecordIdRequest(request)) return recordFail('INVALID_REQUEST');
      return store.read(db => {
        const record = store.record(db, request.id); if (!record) return { record: null };
        const detail = { record, plan: plan(db, record.completion.planVersionId), current: store.state(db, record.completion.physicalId) };
        if (!dto.isRecordingRecordDetail(detail)) return recordFail('IO_ERROR'); return { record: detail };
      });
    },
    visual(request: dto.RecordingVisualRequest): dto.RecordingVisualResult {
      open(); if (!dto.isRecordingVisualRequest(request)) return recordFail('INVALID_REQUEST'); return store.visual(request);
    },
    history(request: dto.PhysicalRecordingHistoryRequest): dto.PhysicalRecordingHistory {
      open(); if (!dto.isPhysicalRecordingHistoryRequest(request)) return recordFail('INVALID_REQUEST');
      return store.read(db => {
        const source = `SELECT 'attempt' kind,a.id,json_extract(a.data,'$.createdAt') created_at,a.data data,r.id recording_id
          FROM recording_attempts a LEFT JOIN recording_records r ON r.attempt_id=a.id WHERE a.physical_id=?
          UNION ALL SELECT 'disposition',json_extract(result,'$.disposition.id'),json_extract(result,'$.disposition.createdAt'),json_extract(result,'$.disposition'),NULL
          FROM recording_record_receipts WHERE json_extract(result,'$.disposition.physicalId')=?`;
        const args = [request.physicalId, request.physicalId], total = Number(db.prepare(`SELECT count(*) n FROM (${source})`).get(...args)!.n);
        const items: dto.PhysicalRecordingHistoryItem[] = db.prepare(`SELECT * FROM (${source}) ORDER BY created_at DESC,kind,id DESC LIMIT ? OFFSET ?`).all(...args, request.page.limit, request.page.offset).map(row => {
          if (row.kind === 'attempt') {
            const attempt: unknown = JSON.parse(String(row.data)); if (!dto.isRecordingAttempt(attempt)) return recordFail('IO_ERROR');
            return { kind: 'attempt', id: String(row.id), createdAt: String(row.created_at), attempt, ...(row.recording_id ? { recordingId: String(row.recording_id) } : {}) };
          }
          const disposition: unknown = JSON.parse(String(row.data)); if (!dto.isPhysicalRecordingDisposition(disposition)) return recordFail('IO_ERROR');
          return { kind: 'disposition', id: String(row.id), createdAt: String(row.created_at), disposition };
        });
        const result = { state: store.state(db, request.physicalId), entries: { items, ...request.page, total, hasMore: request.page.offset + items.length < total } };
        if (!dto.isPhysicalRecordingHistory(result)) return recordFail('IO_ERROR'); return result;
      });
    },
    previewDisposition(request: dto.PreviewPhysicalRecordingDispositionRequest) { open(); return dispositions.preview(structuredClone(request)); },
    applyDisposition(request: dto.ApplyPhysicalRecordingDispositionRequest) { open(); return dispositions.apply(structuredClone(request)); },
    close(): void { closed = true; },
  };
}
export type RecordingRecordCoordinator = ReturnType<typeof createRecordingRecordCoordinator>;
