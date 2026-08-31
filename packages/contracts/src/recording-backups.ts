import { isCollectionId } from './collection.js';
import { isDraftText } from './master-drafts.js';
import { isRestoreActivationView, type ActivateRestoredDataset, type RestoreActivationView } from './recording-activation.js';

export type BackupRootKind = 'backup-destination' | 'backup-source' | 'restore-destination';
export interface BackupRootView { id: string; kind: BackupRootKind; label: string; authorized: boolean }
export interface AuthorizeBackupRoot { commandId: string; kind: BackupRootKind }
export type BackupJobKind = 'backup' | 'verify' | 'restore' | 'index';
export type BackupMode = 'metadata' | 'archive-content';
export type BackupJobState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type BackupJobIssue = 'BACKUP_DESTINATION_INVALID' | 'BACKUP_INCOMPLETE' | 'BACKUP_INVALID' | 'BACKUP_IO_ERROR' | 'AUTHORIZATION_REVOKED' | 'CANCELLED' | 'INTERRUPTED';
interface JobRequestBase { commandId: string; rootId: string; userConfirmed: true }
export type StartBackupJob = JobRequestBase & (
  { kind: 'backup'; mode: BackupMode } | { kind: 'verify' | 'index' } |
  { kind: 'restore'; destinationId: string; verificationId: string }
);
export interface BackupSummary { backupId: string; manifestHash: string; mode: BackupMode; objectCount: number; copyBytes: number; operationCount: number; incompleteCount: number }
export const BACKUP_INDEX_ISSUE_DETAIL_LIMIT = 100;
export const BACKUP_INDEX_MISSING_FACTS = ['physical-recording-completion', 'inventory-and-ledger', 'frozen-version-records', 'profile-snapshots-and-user-confirmations', 'directory-authorizations'] as const;
export type BackupIndexMissingFact = typeof BACKUP_INDEX_MISSING_FACTS[number];
export type BackupIndexIssueCode = 'MANIFEST_INVALID' | 'OBJECT_MISSING' | 'OBJECT_INVALID';
export interface BackupIndexIssueDetail { code: BackupIndexIssueCode; operationId?: string; sha256?: string }
export interface BackupIndexSummary {
  operationCount: number; quarantinedCount: number; issueCount: number; historyTrusted: false; inventoryReconstructed: false;
  issueDetails: readonly BackupIndexIssueDetail[]; issueDetailsOmittedCount: number; missingFacts: readonly BackupIndexMissingFact[];
}
export interface BackupJobView {
  id: string; kind: BackupJobKind; rootId: string; destinationId?: string; state: BackupJobState; createdAt: string;
  mode?: BackupMode; issue?: BackupJobIssue; summary?: BackupSummary; index?: BackupIndexSummary; resultRootId?: string;
}
export interface BackupOverview { roots: readonly BackupRootView[]; jobs: readonly BackupJobView[]; activations: readonly RestoreActivationView[] }

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
export const isBackupRootKind = (v: unknown): v is BackupRootKind => v === 'backup-destination' || v === 'backup-source' || v === 'restore-destination';
export function isAuthorizeBackupRoot(v: unknown): v is AuthorizeBackupRoot {
  return record(v) && keys(v, ['commandId', 'kind']) && isCollectionId(v.commandId) && isBackupRootKind(v.kind);
}
export function isBackupRootView(v: unknown): v is BackupRootView {
  return record(v) && keys(v, ['id', 'kind', 'label', 'authorized']) && isCollectionId(v.id) && isBackupRootKind(v.kind)
    && isDraftText(v.label) && v.label.length <= 240 && !/[\/\\\u0000-\u001f\u007f]/u.test(v.label)
    && typeof v.authorized === 'boolean';
}
export function isBackupOverview(v: unknown): v is BackupOverview {
  return record(v) && keys(v, ['roots', 'jobs', 'activations']) && Array.isArray(v.roots) && v.roots.length <= 100
    && v.roots.every(isBackupRootView) && new Set(v.roots.map(root => root.id)).size === v.roots.length
    && Array.isArray(v.jobs) && v.jobs.length <= 100 && v.jobs.every(isBackupJobView) && new Set(v.jobs.map(job => job.id)).size === v.jobs.length
    && Array.isArray(v.activations) && v.activations.length <= 100 && v.activations.every(isRestoreActivationView)
    && new Set(v.activations.map(activation => activation.id)).size === v.activations.length && v.activations.filter(activation => activation.state === 'active').length <= 1;
}

const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1_099_511_627_776;
const mode = (v: unknown): v is BackupMode => v === 'metadata' || v === 'archive-content';
export function isStartBackupJob(v: unknown): v is StartBackupJob {
  if (!record(v) || !isCollectionId(v.commandId) || !isCollectionId(v.rootId) || v.userConfirmed !== true) return false;
  const base = ['commandId','kind','rootId','userConfirmed'];
  if (v.kind === 'backup') return keys(v, [...base, 'mode']) && mode(v.mode);
  if (v.kind === 'verify' || v.kind === 'index') return keys(v, base);
  return v.kind === 'restore' && keys(v, [...base, 'destinationId','verificationId']) && isCollectionId(v.destinationId) && isCollectionId(v.verificationId) && v.destinationId !== v.rootId;
}
export function isBackupSummary(v: unknown): v is BackupSummary {
  return record(v) && keys(v, ['backupId','manifestHash','mode','objectCount','copyBytes','operationCount','incompleteCount'])
    && isCollectionId(v.backupId) && typeof v.manifestHash === 'string' && /^[a-f0-9]{64}$/u.test(v.manifestHash) && mode(v.mode)
    && [v.objectCount,v.copyBytes,v.operationCount,v.incompleteCount].every(integer);
}
function isBackupIndexIssueDetail(v: unknown): v is BackupIndexIssueDetail {
  if (!record(v) || !keys(v, ['code', 'operationId', 'sha256']) || (v.operationId !== undefined && !isCollectionId(v.operationId))) return false;
  if (v.code === 'MANIFEST_INVALID') return v.sha256 === undefined;
  return (v.code === 'OBJECT_MISSING' || v.code === 'OBJECT_INVALID') && isCollectionId(v.operationId)
    && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(v.sha256);
}
export function isBackupIndexSummary(v: unknown): v is BackupIndexSummary {
  return record(v) && keys(v, ['operationCount', 'quarantinedCount', 'issueCount', 'historyTrusted', 'inventoryReconstructed', 'issueDetails', 'issueDetailsOmittedCount', 'missingFacts'])
    && integer(v.operationCount) && integer(v.quarantinedCount) && v.quarantinedCount <= v.operationCount && integer(v.issueCount)
    && v.historyTrusted === false && v.inventoryReconstructed === false
    && Array.isArray(v.issueDetails) && v.issueDetails.length <= Math.min(v.issueCount, BACKUP_INDEX_ISSUE_DETAIL_LIMIT) && v.issueDetails.every(isBackupIndexIssueDetail)
    && integer(v.issueDetailsOmittedCount) && v.issueDetailsOmittedCount === v.issueCount - v.issueDetails.length
    && Array.isArray(v.missingFacts) && v.missingFacts.length === BACKUP_INDEX_MISSING_FACTS.length
    && BACKUP_INDEX_MISSING_FACTS.every(fact => (v.missingFacts as unknown[]).includes(fact));
}
export function isBackupJobView(v: unknown): v is BackupJobView {
  if (!record(v) || !keys(v, ['id','kind','rootId','destinationId','state','createdAt','mode','issue','summary','index','resultRootId'])
    || !isCollectionId(v.id) || !isCollectionId(v.rootId) || !['backup','verify','restore','index'].includes(String(v.kind))
    || !['queued','running','cancelling','succeeded','failed','cancelled','interrupted'].includes(String(v.state))
    || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt)) || new Date(v.createdAt).toISOString() !== v.createdAt
    || (v.kind === 'restore' ? !isCollectionId(v.destinationId) : v.destinationId !== undefined)
    || (v.kind === 'backup' ? !mode(v.mode) : v.mode !== undefined)) return false;
  if (v.issue !== undefined && !['BACKUP_DESTINATION_INVALID','BACKUP_INCOMPLETE','BACKUP_INVALID','BACKUP_IO_ERROR','AUTHORIZATION_REVOKED','CANCELLED','INTERRUPTED'].includes(String(v.issue))) return false;
  if (v.summary !== undefined && (!isBackupSummary(v.summary) || v.kind === 'index' || v.state !== 'succeeded')) return false;
  if (v.resultRootId !== undefined && (!isCollectionId(v.resultRootId) || v.kind !== 'backup' || v.state !== 'succeeded')) return false;
  if (v.index !== undefined && (!isBackupIndexSummary(v.index) || v.kind !== 'index' || v.state !== 'succeeded')) return false;
  if (v.state === 'succeeded') return v.issue === undefined && (v.kind === 'index' ? v.index !== undefined : v.summary !== undefined) && (v.kind !== 'backup' || v.resultRootId !== undefined);
  return ['queued','running','cancelling'].includes(String(v.state)) ? v.issue === undefined : v.issue !== undefined;
}

export interface RecordingBackupsPublicApi {
  activateRestoredDataset(request: ActivateRestoredDataset): Promise<RestoreActivationView>;
  getBackupOverview(): Promise<BackupOverview>;
  chooseBackupRoot(request: AuthorizeBackupRoot): Promise<BackupRootView | null>;
  startBackupJob(request: StartBackupJob): Promise<BackupJobView>;
  cancelBackupJob(request: { commandId: string; id: string }): Promise<BackupJobView>;
  revokeBackupRoot(request: { commandId: string; id: string }): Promise<BackupRootView>;
}
