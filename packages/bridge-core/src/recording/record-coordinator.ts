import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
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
function physicalAliases(query: string): string[] | undefined {
  const match = /^(?:(MB-)?([CD])-)?(\d{1,9})$/u.exec(query);
  if (!match || Number(match[3]) < 1) return undefined;
  const suffix = String(Number(match[3])).padStart(5, '0');
  return (match[2] ? [match[2]] : ['C', 'D']).map(format => `MB-${format}-${suffix}`);
}
function pageSource(filter: dto.RecordingRecordFilter): { from: string; values: SQLInputValue[] } {
  const conditions: string[] = [], values: SQLInputValue[] = [];
  const exact = (column: string, value?: string) => {
    if (value !== undefined) { conditions.push(`${column}=?`); values.push(value); }
  };
  const contains = (column: string, value?: string) => {
    if (value !== undefined) { conditions.push(`instr(${column},?)>0`); values.push(value.toLowerCase()); }
  };
  exact('s.physical_id', filter.physicalId);
  exact('s.master_version_id', filter.masterVersionId);
  contains('s.track_text', filter.track);
  contains('s.artist_text', filter.artist);
  contains('s.master_text', filter.master);
  contains('s.media_brand_text', filter.mediaBrand);
  contains('s.media_series_text', filter.mediaSeries);
  contains('s.equipment_text', filter.equipment);
  if (filter.completedFrom !== undefined) { conditions.push('s.completed_at>=?'); values.push(filter.completedFrom); }
  if (filter.completedTo !== undefined) { conditions.push('s.completed_at<=?'); values.push(filter.completedTo); }
  if (filter.query) {
    const aliases = physicalAliases(filter.query);
    if (aliases) {
      conditions.push(`s.physical_id IN (${aliases.map(() => '?').join(',')})`);
      values.push(...aliases);
    } else contains('s.query_text', filter.query);
  }
  return { from: `FROM recording_records r JOIN recordpage_search s ON s.record_id=r.id${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`, values };
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
        const { from, values } = pageSource(request.filter ?? {});
        const total = Number(db.prepare(`SELECT COUNT(*) n ${from}`).get(...values)?.n);
        // SQL 固定顺序分页；大库只解析本页的 Record 与冻结 Plan。
        const items: dto.RecordingRecordSummary[] = db.prepare(`SELECT r.id,r.plan_id ${from} ORDER BY s.completed_at DESC,s.record_id DESC LIMIT ? OFFSET ?`)
          .all(...values, request.page.limit, request.page.offset).map(row => {
          const record = store.record(db, String(row.id)) ?? recordFail('IO_ERROR'), frozen = plan(db, String(row.plan_id)), summary = recordingRecordSummary(record, frozen);
          return summary;
        });
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
