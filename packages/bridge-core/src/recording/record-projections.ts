import type { DatabaseSync } from 'node:sqlite';
import { isPhysicalRecordingSummary, type PhysicalRecordingSummary, type RecordingPlanVersion, type RecordingRecord, type RecordingRecordSummary } from '@music-bridge/contracts';
import { parseRecordingPlan } from './plan-integrity.js';
import { readContentHead, readRecordingRecord, recordFail } from './record-integrity.js';
import { verifyFrozenDistribution } from './version-distribution.js';

/** 一条不可变 Record 对应一条轻量搜索行；文本列仅供字面子串匹配。 */
export interface RecordPageSearchProjection {
  record_id: string; physical_id: string; master_version_id: string; completed_at: string;
  master_text: string; media_brand_text: string; media_series_text: string;
  track_text: string; artist_text: string; equipment_text: string; query_text: string;
  record_content_hash: string; plan_content_hash: string; artist_display: string;
}

function diskTracks(plan: RecordingPlanVersion): RecordingPlanVersion['master']['content']['tracks'] {
  const distribution = verifyFrozenDistribution(plan.master, plan.layout);
  if (!distribution) return recordFail('IO_ERROR');
  const byId = new Map(plan.master.content.tracks.map(track => [track.trackId, track]));
  return distribution.trackIds.map(id => byId.get(id) ?? recordFail('IO_ERROR'));
}

/** 分盘档案只索引本盘曲目，不能泄露同组其他盘的曲目或艺人。 */
export function buildRecordPageSearch(record: RecordingRecord, frozenPlan: RecordingPlanVersion): RecordPageSearchProjection {
  const tracks = diskTracks(frozenPlan);
  const artists = tracks.map(track => track.metadata.artist?.trim() ?? '');
  const artistDisplay = artists.length > 0 && artists.every(value => value !== '' && value === artists[0]) ? artists[0]! : '';
  const lower = (value: string): string => value.toLowerCase();
  const master = lower(frozenPlan.master.title);
  const brand = lower(record.media.descriptor?.brand ?? '');
  const series = lower(record.media.descriptor?.name ?? '');
  const trackText = lower(tracks.map(track => track.metadata.title).join(' '));
  const artistText = lower(artists.join(' '));
  const equipment = lower(frozenPlan.profileSnapshot.settings.effective.signalChain.map(step => step.label).join(' '));
  return {
    record_id: record.id, physical_id: record.completion.physicalId, master_version_id: frozenPlan.master.id,
    completed_at: record.completion.endedAt, master_text: master, media_brand_text: brand,
    media_series_text: series, track_text: trackText, artist_text: artistText, equipment_text: equipment,
    query_text: [record.completion.physicalId, master, trackText, artistText, brand, series, equipment, record.completion.endedAt].join(' ').toLowerCase(),
    record_content_hash: record.contentHash, plan_content_hash: frozenPlan.contentHash, artist_display: artistDisplay,
  };
}

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
  const artist = buildRecordPageSearch(record, plan).artist_display || undefined;
  return { id: record.id, physicalId: record.completion.physicalId, attemptId: record.completion.id, planVersionId: record.completion.planVersionId,
    completedAt: record.completion.endedAt, title: plan.master.title, format: plan.layout.spec.format, modelId: record.media.modelId,
    mediaBrand: record.media.descriptor?.brand ?? '', mediaSeries: record.media.descriptor?.name ?? '', ...(artist ? { artist } : {}) };
}

/** 不读取旧标题作为unknown回退。SQL仅是固定只读投影，查询值由调用方绑定。 */
export const formalRecordingMusicSelect = `SELECT c.physical_id id,
  CASE WHEN json_extract(h.data,'$.knowledge.state')='confirmed-recording' THEN json_extract(p.data,'$.master.title') ELSE '当前内容待核实' END title,
  CASE WHEN json_extract(h.data,'$.knowledge.state')='confirmed-recording' THEN COALESCE(rs.artist_display,'') ELSE '' END artist,
  CASE WHEN json_extract(m.descriptor,'$.format')='dat' THEN 'personal-dat' ELSE 'personal-cassette' END kind
  FROM recording_record_current h JOIN physical_copies c ON c.physical_id=h.physical_id
  JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id JOIN collection_models m ON m.id=s.model_id
  LEFT JOIN recording_records r ON r.id=json_extract(h.data,'$.knowledge.recordingId') AND r.physical_id=c.physical_id
  LEFT JOIN recordpage_search rs ON rs.record_id=r.id
  LEFT JOIN recording_plan_versions p ON p.id=r.plan_id`;
