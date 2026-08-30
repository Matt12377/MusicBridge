import type { DatabaseSync } from 'node:sqlite';
import { isPhysicalRecordingSummary, type PhysicalRecordingSummary, type RecordingPlanVersion, type RecordingRecord, type RecordingRecordSummary } from '@music-bridge/contracts';
import { parseRecordingPlan } from './plan-integrity.js';
import { readContentHead, readRecordingRecord, recordFail } from './record-integrity.js';

/** 两个收藏入口共用当前内容投影；历史 Record 不替代当前认知。 */
export function getRecordingCopyProjection(db: DatabaseSync, physicalId: string): { recordingState: PhysicalRecordingSummary; recordingTitle?: string } | undefined {
  const row = db.prepare('SELECT revision,data FROM recording_record_current WHERE physical_id=?').get(physicalId);
  if (!row) return undefined;
  const head = readContentHead(db, physicalId);
  const recordingState = { revision: Number(row.revision), state: head.knowledge.state, ...(head.knowledge.state === 'confirmed-recording' ? { recordingId: head.knowledge.recordingId } : {}) };
  if (head.physicalId !== physicalId || head.revision !== row.revision || !isPhysicalRecordingSummary(recordingState)) return recordFail('IO_ERROR');
  if (recordingState.state !== 'confirmed-recording') return { recordingState };
  const record = readRecordingRecord(db, recordingState.recordingId);
  if (!record || record.completion.physicalId !== physicalId) return recordFail('IO_ERROR');
  const plan = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(record.completion.planVersionId);
  if (!plan) return recordFail('IO_ERROR');
  return { recordingState, recordingTitle: parseRecordingPlan(plan.data).master.title };
}

export function recordingRecordSummary(record: RecordingRecord, plan: RecordingPlanVersion): RecordingRecordSummary {
  const artists = plan.master.content.tracks.map(track => track.metadata.artist?.trim() ?? '');
  const artist = artists.length && artists.every(value => value && value === artists[0]) ? artists[0] : undefined;
  return { id: record.id, physicalId: record.completion.physicalId, attemptId: record.completion.id, planVersionId: record.completion.planVersionId,
    completedAt: record.completion.endedAt, title: plan.master.title, format: plan.layout.spec.format, modelId: record.media.modelId,
    mediaBrand: record.media.descriptor?.brand ?? '', mediaSeries: record.media.descriptor?.name ?? '', ...(artist ? { artist } : {}) };
}

/** 不读取旧标题作为unknown回退。SQL仅是固定只读投影，查询值由调用方绑定。 */
export const formalRecordingMusicSelect = `SELECT c.physical_id id,
  CASE WHEN json_extract(h.data,'$.knowledge.state')='confirmed-recording' THEN json_extract(p.data,'$.master.title') ELSE '当前内容待核实' END title,
  CASE WHEN json_extract(h.data,'$.knowledge.state')='confirmed-recording'
    AND NOT EXISTS(SELECT 1 FROM json_each(p.data,'$.master.content.tracks') WHERE trim(COALESCE(json_extract(value,'$.metadata.artist'),''))='')
    AND (SELECT count(DISTINCT trim(json_extract(value,'$.metadata.artist'))) FROM json_each(p.data,'$.master.content.tracks'))=1
    THEN (SELECT trim(json_extract(value,'$.metadata.artist')) FROM json_each(p.data,'$.master.content.tracks') LIMIT 1) ELSE '' END artist,
  CASE WHEN json_extract(m.descriptor,'$.format')='dat' THEN 'personal-dat' ELSE 'personal-cassette' END kind
  FROM recording_record_current h JOIN physical_copies c ON c.physical_id=h.physical_id
  JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id JOIN collection_models m ON m.id=s.model_id
  LEFT JOIN recording_records r ON r.id=json_extract(h.data,'$.knowledge.recordingId') AND r.physical_id=c.physical_id
  LEFT JOIN recording_plan_versions p ON p.id=r.plan_id`;
