import { isCollectionId } from './collection.js';
import { isRenderSide, type RenderSide } from './prepared-render.js';

export const RECORDING_OUTPUT_BACKEND_ID = 'musicbridge-coreaudio-hal' as const;
export const RECORDING_OUTPUT_BACKEND_VERSION = '0.1.0' as const;
export const RECORDING_OUTPUT_PROTOCOL_VERSION = 1 as const;

/** 构建及合成检查能力不代表设备授权、排空证据或 Gate B 认证。 */
export interface RecordingOutputStatus {
  backend: { id: typeof RECORDING_OUTPUT_BACKEND_ID; version: typeof RECORDING_OUTPUT_BACKEND_VERSION; halAdapterCompiled: boolean };
  syntheticCheck: { available: boolean; helperSha256: string | null; protocolVersion: typeof RECORDING_OUTPUT_PROTOCOL_VERSION };
  deviceAccess: 'not-authorized'; gateB: 'NOT_RUN'; formalReady: false;
}
export interface RecordingOutputCheckRequest { runId: string; planVersionId: string; side: RenderSide }
export interface RecordingOutputCancelRequest { runId: string }
/** 只报告成功的合成消费；取消、异常和设备效果不能伪装为 verified。 */
export interface RecordingOutputCheckResult {
  state: 'verified'; runId: string; planVersionId: string; planContentHash: string; side: RenderSide;
  frameCount: number; consumedFrames: number; pcmSha256: string; helperSha256: string;
  deviceOpened: false; formalReady: false; gateB: 'NOT_RUN'; evidence: 'synthetic-only';
}
export interface RecordingOutputPublicApi {
  getRecordingOutputStatus(): Promise<RecordingOutputStatus>;
  checkRecordingOutput(request: RecordingOutputCheckRequest): Promise<RecordingOutputCheckResult>;
  cancelRecordingOutputCheck(runId: string): Promise<{ cancelled: true }>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(key => allowed.includes(key));
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/u.test(v);
const positiveInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export function isRecordingOutputStatus(v: unknown): v is RecordingOutputStatus {
  if (!record(v) || !keys(v, ['backend', 'syntheticCheck', 'deviceAccess', 'gateB', 'formalReady'])
    || v.deviceAccess !== 'not-authorized' || v.gateB !== 'NOT_RUN' || v.formalReady !== false
    || !record(v.backend) || !keys(v.backend, ['id', 'version', 'halAdapterCompiled'])
    || v.backend.id !== RECORDING_OUTPUT_BACKEND_ID || v.backend.version !== RECORDING_OUTPUT_BACKEND_VERSION || typeof v.backend.halAdapterCompiled !== 'boolean'
    || !record(v.syntheticCheck) || !keys(v.syntheticCheck, ['available', 'helperSha256', 'protocolVersion'])
    || v.syntheticCheck.protocolVersion !== RECORDING_OUTPUT_PROTOCOL_VERSION || typeof v.syntheticCheck.available !== 'boolean') return false;
  return v.syntheticCheck.available === v.backend.halAdapterCompiled
    && (v.syntheticCheck.available ? hash(v.syntheticCheck.helperSha256) : v.syntheticCheck.helperSha256 === null);
}
export function isRecordingOutputCheckRequest(v: unknown): v is RecordingOutputCheckRequest {
  return record(v) && keys(v, ['runId', 'planVersionId', 'side']) && isCollectionId(v.runId) && isCollectionId(v.planVersionId) && isRenderSide(v.side);
}
export function isRecordingOutputCancelRequest(v: unknown): v is RecordingOutputCancelRequest {
  return record(v) && keys(v, ['runId']) && isCollectionId(v.runId);
}
export function isRecordingOutputCheckResult(v: unknown): v is RecordingOutputCheckResult {
  return record(v) && keys(v, ['state', 'runId', 'planVersionId', 'planContentHash', 'side', 'frameCount', 'consumedFrames', 'pcmSha256', 'helperSha256', 'deviceOpened', 'formalReady', 'gateB', 'evidence'])
    && v.state === 'verified' && isCollectionId(v.runId) && isCollectionId(v.planVersionId) && hash(v.planContentHash) && isRenderSide(v.side)
    && positiveInteger(v.frameCount) && v.consumedFrames === v.frameCount && hash(v.pcmSha256) && hash(v.helperSha256)
    && v.deviceOpened === false && v.formalReady === false && v.gateB === 'NOT_RUN' && v.evidence === 'synthetic-only';
}
