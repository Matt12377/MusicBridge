/** 独立兼容接点：不能把结构合法提升为 Controller/Roon 观察真实性。 */
export type LocalPlaybackCompatibility =
  | { supported: true; protocol: 'legacy' | 'compact-v1'; source: 'roon' | 'netease' }
  | { supported: false; code: 'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED' | 'PLAYBACK_PROTOCOL_UNSUPPORTED' | 'PLAYBACK_SOURCE_UNSUPPORTED' };
export function evaluateLocalPlaybackCompatibility(protocol: unknown, source: unknown): LocalPlaybackCompatibility {
  if (protocol !== 'legacy' && protocol !== 'compact-v1') return { supported: false, code: 'PLAYBACK_PROTOCOL_UNSUPPORTED' };
  if (source === 'local_file') return { supported: false, code: 'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED' };
  if (source !== 'roon' && source !== 'netease') return { supported: false, code: 'PLAYBACK_SOURCE_UNSUPPORTED' };
  return { supported: true, protocol, source };
}
export interface LocalPlaybackObservationLeaf {
  schema_version: '1.2'; request_id: string; attempt_id: string; intent_generation: string;
  route: 'roon_audio_input'; local_track_id: string; asset_id: string; asset_revision: string;
  target: { core_id: string; zone_id: string }; session_epoch: string | null;
  phase: 'PREPARING' | 'SUBMITTING' | 'AWAITING_ROON' | 'PLAYING' | 'PAUSED' | 'ENDED' | 'FAILED' | 'CANCELLED' | 'SUBMISSION_UNKNOWN' | 'OWNERSHIP_LOST';
  ownership: 'MB_PENDING' | 'MB_OWNED' | 'EXTERNAL' | 'NONE' | 'UNKNOWN';
  queue_owner: 'MB' | 'ROON_NATIVE_EXTERNAL' | 'NONE' | 'UNKNOWN';
  delivery_state: 'NOT_STARTED' | 'READ_REQUESTED' | 'SENDING' | 'BYTES_SENT' | 'FAILED' | 'UNKNOWN';
  roon_observation: { event: 'NONE' | 'PLAYING' | 'PAUSED' | 'TIME' | 'ENDED' | 'ERROR' | 'SESSION_ENDED' | 'EXTERNAL_TAKEOVER' | 'UNKNOWN'; observed: boolean; correlation: 'ATTEMPT_CONFIRMED' | 'PARTIAL' | 'UNKNOWN' };
  position_ms: number | null;
  quality: { http_bytes: 'NOT_TESTED' | 'SAMPLE_VERIFIED' | 'FAILED'; signal_path: 'NOT_TESTED' | 'OBSERVED' | 'MISMATCH'; digital_output: 'NOT_TESTED' | 'TEST_CONDITIONS_VERIFIED' | 'FAILED'; gapless: 'NOT_TESTED' | 'TEST_CONDITIONS_VERIFIED' | 'UNSUPPORTED' | 'FAILED' };
  error_code: string | null;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v: Record<string, unknown>, keys: readonly string[]): boolean => keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max * 2 && Array.from(v).length <= max;
const decimal = (v: unknown): v is string => typeof v === 'string' && v.length <= 20 && /^(0|[1-9][0-9]*)$/u.test(v) && !/[^0-9]/u.test(v);
const one = (v: unknown, choices: readonly string[]): boolean => typeof v === 'string' && choices.includes(v);
/** 只验证本地 attempt 叶结构与一致性，不注册 IPC event/ACK，不分配代际或生成 Playing。 */
export function isLocalPlaybackObservationLeaf(v: unknown): v is LocalPlaybackObservationLeaf {
  if (!record(v) || !closed(v, ['schema_version','request_id','attempt_id','intent_generation','route','local_track_id','asset_id','asset_revision','target','session_epoch','phase','ownership','queue_owner','delivery_state','roon_observation','position_ms','quality','error_code'])
    || v.schema_version !== '1.2' || v.route !== 'roon_audio_input' || !text(v.request_id) || !text(v.attempt_id)
    || !text(v.local_track_id) || !text(v.asset_id) || !decimal(v.intent_generation) || !decimal(v.asset_revision)
    || !record(v.target) || !closed(v.target, ['core_id','zone_id']) || !text(v.target.core_id) || !text(v.target.zone_id)
    || !(v.session_epoch === null || text(v.session_epoch, 4096)) || !(v.error_code === null || text(v.error_code, 4096))
    || !one(v.phase,['PREPARING','SUBMITTING','AWAITING_ROON','PLAYING','PAUSED','ENDED','FAILED','CANCELLED','SUBMISSION_UNKNOWN','OWNERSHIP_LOST'])
    || !one(v.ownership,['MB_PENDING','MB_OWNED','EXTERNAL','NONE','UNKNOWN']) || !one(v.queue_owner,['MB','ROON_NATIVE_EXTERNAL','NONE','UNKNOWN'])
    || !one(v.delivery_state,['NOT_STARTED','READ_REQUESTED','SENDING','BYTES_SENT','FAILED','UNKNOWN'])
    || !(v.position_ms === null || typeof v.position_ms === 'number' && Number.isSafeInteger(v.position_ms) && v.position_ms >= 0)
    || !record(v.roon_observation) || !closed(v.roon_observation,['event','observed','correlation'])
    || !one(v.roon_observation.event,['NONE','PLAYING','PAUSED','TIME','ENDED','ERROR','SESSION_ENDED','EXTERNAL_TAKEOVER','UNKNOWN'])
    || typeof v.roon_observation.observed !== 'boolean' || !one(v.roon_observation.correlation,['ATTEMPT_CONFIRMED','PARTIAL','UNKNOWN'])
    || !record(v.quality) || !closed(v.quality,['http_bytes','signal_path','digital_output','gapless'])
    || !one(v.quality.http_bytes,['NOT_TESTED','SAMPLE_VERIFIED','FAILED']) || !one(v.quality.signal_path,['NOT_TESTED','OBSERVED','MISMATCH'])
    || !one(v.quality.digital_output,['NOT_TESTED','TEST_CONDITIONS_VERIFIED','FAILED']) || !one(v.quality.gapless,['NOT_TESTED','TEST_CONDITIONS_VERIFIED','UNSUPPORTED','FAILED'])) return false;
  if (v.phase === 'PLAYING' && (v.ownership !== 'MB_OWNED' || !text(v.session_epoch) || v.roon_observation.observed !== true
    || !one(v.roon_observation.event,['PLAYING','TIME']) || v.roon_observation.correlation !== 'ATTEMPT_CONFIRMED')) return false;
  if (v.phase === 'OWNERSHIP_LOST' && !one(v.ownership,['EXTERNAL','NONE','UNKNOWN'])) return false;
  return true;
}
