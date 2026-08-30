import { isCollectionId } from './collection.js';
import { isDraftText } from './master-drafts.js';
import { isExecutionFormat, type ExecutionFormat } from './execution-audio.js';
import type { MediaCompatibility } from './media-planning.js';

export interface RecordingChainStep { id: string; kind: 'audio-interface' | 'dac' | 'digital-output' | 'cassette-deck' | 'dat-recorder' | 'connection'; label: string }
export interface RecordingDefaults { noiseReduction: string | null; calibration: string | null; recordLevel: string | null; preRollMs: number }
export type RecordingFormatSettings = Omit<ExecutionFormat, 'outputProfileVersion'>;
/** 设备链和后端信息为用户的计划参数；保存不操作设备，也不提供认证证明。 */
export interface RecordingProfileContent { name: string; signalChain: readonly RecordingChainStep[]; defaults: RecordingDefaults; compatibility: MediaCompatibility; executionFormat: RecordingFormatSettings }
export interface RecordingProfileVersion { id: string; profileId: string; sequence: number; parentVersionId?: string; createdAt: string; content: RecordingProfileContent; contentHash: string }
export interface RecordingProfileHistory { profileId: string; versions: readonly RecordingProfileVersion[] }
export interface SaveRecordingProfileRequest { commandId: string; profileId?: string; expectedVersionId?: string; content: RecordingProfileContent; userConfirmed: true }
/** undefined 表示继承；null 明确表示本次未设定，不会退回默认值。 */
export interface RecordingSessionOverrides { noiseReduction?: string | null; calibration?: string | null; recordLevel?: string | null; signalChain?: readonly RecordingChainStep[] }
export interface RecordingSessionSettings { draftId: string; revision: number; profileVersionId: string; overrides: RecordingSessionOverrides; updatedAt: string }
export interface SaveRecordingSessionRequest { commandId: string; draftId: string; expectedRevision: number; profileVersionId: string; overrides: RecordingSessionOverrides; userConfirmed: true }
export interface EffectiveRecordingSettings extends RecordingDefaults { signalChain: readonly RecordingChainStep[] }
/** 编译准备的独立参数副本；正式 RecordingProfileSnapshot 由后续 Plan Freeze 建立。 */
export interface ResolvedRecordingSettings { profile: RecordingProfileVersion; overrides: RecordingSessionOverrides; effective: EffectiveRecordingSettings; format: ExecutionFormat; fingerprint: string }
export interface RecordingProfilesPublicApi {
  listRecordingProfiles(): Promise<{ profiles: readonly RecordingProfileVersion[] }>;
  getRecordingProfileHistory(profileId: string): Promise<RecordingProfileHistory>;
  getRecordingProfileVersion(versionId: string): Promise<RecordingProfileVersion>;
  saveRecordingProfile(request: SaveRecordingProfileRequest): Promise<RecordingProfileVersion>;
  getRecordingSession(draftId: string): Promise<{ session: RecordingSessionSettings | null }>;
  saveRecordingSession(request: SaveRecordingSessionRequest): Promise<RecordingSessionSettings>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v);
const note = (v: unknown): v is string | null => v === null || isDraftText(v);
export function isRecordingSignalChain(v: unknown): v is readonly RecordingChainStep[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 16 && v.every(step => record(step) && keys(step, ['id','kind','label']) && isCollectionId(step.id) && typeof step.kind === 'string' && ['audio-interface','dac','digital-output','cassette-deck','dat-recorder','connection'].includes(step.kind) && isDraftText(step.label)) && new Set(v.map(step => step.id)).size === v.length;
}
export function isRecordingFormatSettings(v: unknown): v is RecordingFormatSettings { return record(v) && !('outputProfileVersion' in v) && isExecutionFormat({ ...v, outputProfileVersion: '00000000-0000-4000-8000-000000000000' }); }
function compatibility(v: unknown): v is MediaCompatibility { return record(v) && keys(v, ['confirmed','cassetteTypes','dat']) && typeof v.confirmed === 'boolean' && typeof v.dat === 'boolean' && Array.isArray(v.cassetteTypes) && v.cassetteTypes.length <= 4 && v.cassetteTypes.every(t => typeof t === 'string' && ['I','II','III','IV'].includes(t)) && new Set(v.cassetteTypes).size === v.cassetteTypes.length; }
function defaults(v: unknown): v is RecordingDefaults { return record(v) && keys(v, ['noiseReduction','calibration','recordLevel','preRollMs']) && note(v.noiseReduction) && note(v.calibration) && note(v.recordLevel) && integer(v.preRollMs, 0, 600000); }
export function isRecordingProfileContent(v: unknown): v is RecordingProfileContent { return record(v) && keys(v, ['name','signalChain','defaults','compatibility','executionFormat']) && isDraftText(v.name) && isRecordingSignalChain(v.signalChain) && defaults(v.defaults) && compatibility(v.compatibility) && isRecordingFormatSettings(v.executionFormat); }
export function isRecordingProfileVersion(v: unknown): v is RecordingProfileVersion { return record(v) && keys(v, ['id','profileId','sequence','parentVersionId','createdAt','content','contentHash']) && isCollectionId(v.id) && isCollectionId(v.profileId) && integer(v.sequence, 1, 100) && (v.sequence === 1 ? v.parentVersionId === undefined : isCollectionId(v.parentVersionId) && v.parentVersionId !== v.id) && date(v.createdAt) && isRecordingProfileContent(v.content) && hash(v.contentHash); }
export function isRecordingProfileHistory(v: unknown): v is RecordingProfileHistory {
  if (!record(v) || !keys(v, ['profileId','versions']) || !isCollectionId(v.profileId) || !Array.isArray(v.versions) || !v.versions.length || v.versions.length > 100 || !v.versions.every(isRecordingProfileVersion)) return false;
  const versions = v.versions;
  return new Set(versions.map(p => p.id)).size === versions.length && versions.every((p, i) => p.profileId === v.profileId && p.sequence === versions.length - i && (p.sequence === 1 || p.parentVersionId === versions[i + 1]?.id));
}
export function isSaveRecordingProfileRequest(v: unknown): v is SaveRecordingProfileRequest { return record(v) && keys(v, ['commandId','profileId','expectedVersionId','content','userConfirmed']) && isCollectionId(v.commandId) && isRecordingProfileContent(v.content) && v.userConfirmed === true && (v.profileId === undefined ? v.expectedVersionId === undefined : isCollectionId(v.profileId) && isCollectionId(v.expectedVersionId)); }
export function isRecordingSessionOverrides(v: unknown): v is RecordingSessionOverrides { return record(v) && keys(v, ['noiseReduction','calibration','recordLevel','signalChain']) && ['noiseReduction','calibration','recordLevel'].every(k => v[k] === undefined || note(v[k])) && (v.signalChain === undefined || isRecordingSignalChain(v.signalChain)); }
export function isRecordingSessionSettings(v: unknown): v is RecordingSessionSettings { return record(v) && keys(v, ['draftId','revision','profileVersionId','overrides','updatedAt']) && isCollectionId(v.draftId) && integer(v.revision, 1) && isCollectionId(v.profileVersionId) && isRecordingSessionOverrides(v.overrides) && date(v.updatedAt); }
export function isSaveRecordingSessionRequest(v: unknown): v is SaveRecordingSessionRequest { return record(v) && keys(v, ['commandId','draftId','expectedRevision','profileVersionId','overrides','userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.draftId) && integer(v.expectedRevision) && isCollectionId(v.profileVersionId) && isRecordingSessionOverrides(v.overrides) && v.userConfirmed === true; }
export function effectiveRecordingSettings(profile: RecordingProfileVersion, overrides: RecordingSessionOverrides): EffectiveRecordingSettings {
  return { signalChain: structuredClone(overrides.signalChain ?? profile.content.signalChain), preRollMs: profile.content.defaults.preRollMs, noiseReduction: overrides.noiseReduction === undefined ? profile.content.defaults.noiseReduction : overrides.noiseReduction, calibration: overrides.calibration === undefined ? profile.content.defaults.calibration : overrides.calibration, recordLevel: overrides.recordLevel === undefined ? profile.content.defaults.recordLevel : overrides.recordLevel };
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v,i) => same(v,b[i]));
  return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k,v]) => Object.hasOwn(b,k) && same(v,b[k]));
}
export function isResolvedRecordingSettings(v: unknown): v is ResolvedRecordingSettings {
  return record(v) && keys(v, ['profile','overrides','effective','format','fingerprint']) && isRecordingProfileVersion(v.profile) && isRecordingSessionOverrides(v.overrides) && hash(v.fingerprint) && same(v.effective, effectiveRecordingSettings(v.profile, v.overrides)) && isExecutionFormat(v.format) && same(v.format, { ...v.profile.content.executionFormat, outputProfileVersion: v.profile.id });
}
