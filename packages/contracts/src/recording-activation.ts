import { isCollectionId } from './collection.js';

export interface ActivateRestoredDataset {
  commandId: string;
  restoreJobId: string;
  expectedActiveId: string | null;
  userConfirmed: true;
  stopPlaybackConfirmed: true;
}
export type RestoreActivationState = 'preparing' | 'prepared' | 'activating' | 'active' | 'superseded' | 'failed' | 'rolled-back';
export type RestoreActivationIssue = 'PREPARATION_FAILED' | 'PREPARATION_INTERRUPTED' | 'BOOT_FAILED' | 'BOOT_INTERRUPTED';
export interface RestoreActivationView {
  id: string; restoreJobId: string; previousId: string | null; state: RestoreActivationState;
  createdAt: string; contentIncluded?: boolean; issue?: RestoreActivationIssue;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(key => allowed.includes(key));
export function isActivateRestoredDataset(v: unknown): v is ActivateRestoredDataset {
  return record(v) && keys(v, ['commandId','restoreJobId','expectedActiveId','userConfirmed','stopPlaybackConfirmed'])
    && isCollectionId(v.commandId) && isCollectionId(v.restoreJobId) && (v.expectedActiveId === null || isCollectionId(v.expectedActiveId))
    && v.userConfirmed === true && v.stopPlaybackConfirmed === true;
}
export function isRestoreActivationView(v: unknown): v is RestoreActivationView {
  if (!record(v) || !keys(v, ['id','restoreJobId','previousId','state','createdAt','contentIncluded','issue'])
    || !isCollectionId(v.id) || !isCollectionId(v.restoreJobId) || !(v.previousId === null || isCollectionId(v.previousId))
    || !['preparing','prepared','activating','active','superseded','failed','rolled-back'].includes(String(v.state))
    || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt)) || new Date(v.createdAt).toISOString() !== v.createdAt
    || v.contentIncluded !== undefined && typeof v.contentIncluded !== 'boolean') return false;
  if (['prepared','activating','active','superseded','rolled-back'].includes(String(v.state)) && typeof v.contentIncluded !== 'boolean') return false;
  if (v.state === 'failed') return v.issue === 'PREPARATION_FAILED' || v.issue === 'PREPARATION_INTERRUPTED';
  if (v.state === 'rolled-back') return v.issue === 'BOOT_FAILED' || v.issue === 'BOOT_INTERRUPTED';
  return v.issue === undefined;
}
