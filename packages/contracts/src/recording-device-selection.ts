/** 设备选择只由 Core 的当前候选目录签发；Renderer 不提交 UID 或配置指纹。 */
export interface RecordingOutputSelection { endpointId: string; selectionGeneration: string }
export interface RecordingDeviceCandidate { endpointId: string; label: string; available: boolean }
export type RecordingDeviceBlockReason = 'NO_DEVICE_CATALOG' | 'NO_CANDIDATES' | 'HELPER_UNAVAILABLE' | 'OUTPUT_RUN_UNVERIFIED';
export interface RecordingDeviceCandidates {
  candidates: readonly RecordingDeviceCandidate[];
  selected: RecordingOutputSelection | null;
  blockedReason: RecordingDeviceBlockReason | null;
  deviceOpened: false; gateB: 'NOT_RUN'; formalReady: false;
}
export interface SelectRecordingDeviceRequest { endpointId: string }
export interface RecordingDeviceSelectionPublicApi {
  listRecordingDeviceCandidates(): Promise<RecordingDeviceCandidates>;
  selectRecordingDevice(request: SelectRecordingDeviceRequest): Promise<RecordingOutputSelection>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const endpoint = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) && value.trim() === value;

export function isRecordingOutputSelection(value: unknown): value is RecordingOutputSelection {
  return record(value) && keys(value, ['endpointId', 'selectionGeneration']) && endpoint(value.endpointId) && uuid(value.selectionGeneration);
}
export function isRecordingDeviceCandidate(value: unknown): value is RecordingDeviceCandidate {
  return record(value) && keys(value, ['endpointId', 'label', 'available']) && endpoint(value.endpointId) && label(value.label) && typeof value.available === 'boolean';
}
export function isSelectRecordingDeviceRequest(value: unknown): value is SelectRecordingDeviceRequest {
  return record(value) && keys(value, ['endpointId']) && endpoint(value.endpointId);
}
export function isRecordingDeviceCandidates(value: unknown): value is RecordingDeviceCandidates {
  const selected = record(value) ? value.selected : undefined;
  if (!record(value) || !keys(value, ['candidates', 'selected', 'blockedReason', 'deviceOpened', 'gateB', 'formalReady'])
    || !Array.isArray(value.candidates) || value.candidates.length > 64 || !value.candidates.every(isRecordingDeviceCandidate)
    || new Set(value.candidates.map(candidate => candidate.endpointId)).size !== value.candidates.length
    || value.deviceOpened !== false || value.gateB !== 'NOT_RUN' || value.formalReady !== false
    || selected !== null && !isRecordingOutputSelection(selected)) return false;
  if (selected !== null && !value.candidates.some(candidate => candidate.endpointId === selected.endpointId && candidate.available)) return false;
  if (value.blockedReason === null) return value.candidates.some(candidate => candidate.available);
  return value.blockedReason === 'NO_DEVICE_CATALOG' || value.blockedReason === 'NO_CANDIDATES' || value.blockedReason === 'HELPER_UNAVAILABLE' || value.blockedReason === 'OUTPUT_RUN_UNVERIFIED';
}
