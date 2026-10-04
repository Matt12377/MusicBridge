/** 原冻结pack的公开九字段；内部意图guard只证明结构，不证明Controller来源。 */
export const LOCAL_PLAY_ACTIONS = ['PLAY_NOW', 'APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE'] as const;
export type LocalPlayAction = typeof LOCAL_PLAY_ACTIONS[number];
export interface LocalPlayTarget { core_id: string; zone_id: string }
export interface LocalPlayRequest {
  schema_version: '1.2'; request_id: string; route: 'roon_audio_input'; source_kind: 'local_file';
  local_track_id: string; asset_id: string; expected_asset_revision: string; target: LocalPlayTarget; action: LocalPlayAction;
}
export interface LocalPlaybackIntent extends LocalPlayRequest {
  intent_generation: string; attempt_id: string;
  segment: { segment_id: string; start_frame: string; end_frame_exclusive: string; timebase_hz: number } | null;
  selection_revision: string; autoplay_after_restart: false;
}
export interface LocalSourceUnsupported { status: 'unsupported'; reason: 'TARGET_AUTHORITY_UNAVAILABLE' }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: readonly string[]): boolean => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).length === required.length && Object.keys(v).every(k => required.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 512 && Array.from(v).length <= 256;
// 保留原pack pattern/maxLength与0/20位范围，不使用目录positive-u64或Number。
export const isLocalPlayDecimal = (v: unknown): v is string => typeof v === 'string' && v.length <= 20 && /^(0|[1-9][0-9]*)$/u.test(v);
export const isLocalPlayTarget = (v: unknown): v is LocalPlayTarget => record(v) && keys(v, ['core_id','zone_id']) && text(v.core_id) && text(v.zone_id);
const publicKeys = ['schema_version','request_id','route','source_kind','local_track_id','asset_id','expected_asset_revision','target','action'] as const;
function publicFields(v: Record<string, unknown>): boolean {
  return v.schema_version === '1.2' && text(v.request_id) && v.route === 'roon_audio_input' && v.source_kind === 'local_file'
    && text(v.local_track_id) && text(v.asset_id) && isLocalPlayDecimal(v.expected_asset_revision) && isLocalPlayTarget(v.target)
    && (LOCAL_PLAY_ACTIONS as readonly unknown[]).includes(v.action);
}
export const isLocalPlayRequest = (v: unknown): v is LocalPlayRequest => record(v) && keys(v, publicKeys) && publicFields(v);
export function isLocalPlaybackIntent(v: unknown): v is LocalPlaybackIntent {
  if (!record(v) || !keys(v, [...publicKeys,'intent_generation','attempt_id','segment','selection_revision','autoplay_after_restart']) || !publicFields(v)) return false;
  const segment = v.segment;
  return isLocalPlayDecimal(v.intent_generation) && text(v.attempt_id) && isLocalPlayDecimal(v.selection_revision) && v.autoplay_after_restart === false
    && (segment === null || record(segment) && keys(segment, ['segment_id','start_frame','end_frame_exclusive','timebase_hz'])
      && text(segment.segment_id) && isLocalPlayDecimal(segment.start_frame) && isLocalPlayDecimal(segment.end_frame_exclusive)
      && typeof segment.timebase_hz === 'number' && Number.isInteger(segment.timebase_hz) && segment.timebase_hz >= 1 && segment.timebase_hz <= 1_000_000_000);
}
export const isLocalSourceUnsupported = (v: unknown): v is LocalSourceUnsupported => record(v) && keys(v, ['status','reason']) && v.status === 'unsupported' && v.reason === 'TARGET_AUTHORITY_UNAVAILABLE';
