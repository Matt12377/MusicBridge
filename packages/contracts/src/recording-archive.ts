import { isCollectionId } from './collection.js';
import { isDraftText } from './master-drafts.js';
import type { ExecutionMode } from './execution-assets.js';

export type ArchiveSourcePolicy = 'reference-dependent' | 'preserve-exact-sources';
export type ArchiveRootState = 'selected' | 'initializing' | 'ready' | 'offline' | 'recovery-required' | 'revoked';
export interface ArchiveRootView { id: string; label: string; state: ArchiveRootState }
export interface InitializeArchiveRequest { commandId: string; id: string; userConfirmed: true }
export interface ArchiveSelection { assetId: string; rootId: string; sourcePolicy: ArchiveSourcePolicy }
export interface PreviewArchiveRequest extends ArchiveSelection { readId: string }
export interface StartArchiveRequest extends ArchiveSelection { commandId: string; proposalFingerprint: string; userConfirmed: true }
export type ArchiveObjectRole = 'execution-audio' | 'conversion-intermediate' | 'raw-render' | 'exact-source' | 'manifest' | 'metadata';
export interface ArchiveObjectDescriptor { role: ArchiveObjectRole; name: string; sha256: string; size: number; media: 'audio' | 'json' }
export interface ArchiveProposal extends ArchiveSelection {
  draftId: string; masterVersionId: string; layoutVersionId: string; mode: ExecutionMode; preparedVersionId?: string;
  files: readonly ArchiveObjectDescriptor[]; objectCount: number; copyBytes: number; requiredBytes: number; availableBytes: number;
  proposalFingerprint: string; retentionPolicy: 'unresolved-no-automatic-deletion'; formalReady: false;
}
export type ArchivePhase = 'REQUESTED' | 'INTENT_WRITTEN' | 'STAGED' | 'VERIFIED' | 'PROMOTED' | 'DB_COMMITTED' | 'FINALIZED';
export type ArchiveIssue = 'ARCHIVE_ROOT_INVALID' | 'ARCHIVE_RECOVERY_REQUIRED' | 'ARCHIVE_DISK_FULL' | 'SOURCE_INVALID' | 'CANCELLED' | 'IO_ERROR';
export interface ArchiveOperationView extends ArchiveSelection {
  id: string; draftId: string; masterVersionId: string; layoutVersionId: string; phase: ArchivePhase; active: boolean;
  issue?: ArchiveIssue; objectCount: number; copyBytes: number; createdAt: string; formalReady: false;
}
export interface ArchiveHistory { draftId: string; operations: readonly ArchiveOperationView[] }
export interface VerifyArchiveRequest { id: string; readId: string }
export interface ArchiveCheck { id: string; state: 'verified' | 'unavailable'; checkedAt: string; reason?: ArchiveIssue; formalReady: false }
export interface RecordingArchivePublicApi {
  listArchiveRoots(): Promise<{ roots: readonly ArchiveRootView[] }>;
  chooseArchiveRoot(commandId: string): Promise<ArchiveRootView | null>;
  initializeArchiveRoot(request: InitializeArchiveRequest): Promise<ArchiveRootView>;
  revokeArchiveRoot(request: { commandId: string; id: string }): Promise<ArchiveRootView>;
  previewArchive(request: PreviewArchiveRequest): Promise<ArchiveProposal>;
  startArchive(request: StartArchiveRequest): Promise<ArchiveOperationView>;
  listArchives(draftId: string): Promise<ArchiveHistory>;
  getArchiveOperation(id: string): Promise<{ operation: ArchiveOperationView | null }>;
  cancelArchive(request: { commandId: string; id: string }): Promise<ArchiveOperationView>;
  resumeArchive(request: { commandId: string; id: string }): Promise<ArchiveOperationView>;
  verifyArchive(request: VerifyArchiveRequest): Promise<ArchiveCheck>;
  cancelArchiveRead(id: string): Promise<{ cancelled: true }>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const name = (v: unknown): v is string => isDraftText(v) && v.length <= 240 && v !== '.' && v !== '..' && !/[\/\\\u0000-\u001f\u007f]/u.test(v);
const policy = (v: unknown): v is ArchiveSourcePolicy => v === 'reference-dependent' || v === 'preserve-exact-sources';
const issue = (v: unknown): v is ArchiveIssue => typeof v === 'string' && ['ARCHIVE_ROOT_INVALID','ARCHIVE_RECOVERY_REQUIRED','ARCHIVE_DISK_FULL','SOURCE_INVALID','CANCELLED','IO_ERROR'].includes(v);
const selectionKeys = ['assetId','rootId','sourcePolicy'];
const selected = (v: Record<string, unknown>): boolean => isCollectionId(v.assetId) && isCollectionId(v.rootId) && policy(v.sourcePolicy);
export const ARCHIVE_SPACE_RESERVE = 8 * 1024 * 1024;
export function isArchiveRootView(v: unknown): v is ArchiveRootView { return record(v) && keys(v, ['id','label','state']) && isCollectionId(v.id) && name(v.label) && typeof v.state === 'string' && ['selected','initializing','ready','offline','recovery-required','revoked'].includes(v.state); }
export function isInitializeArchiveRequest(v: unknown): v is InitializeArchiveRequest { return record(v) && keys(v, ['commandId','id','userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.id) && v.userConfirmed === true; }
export function isPreviewArchiveRequest(v: unknown): v is PreviewArchiveRequest { return record(v) && keys(v, [...selectionKeys,'readId']) && selected(v) && isCollectionId(v.readId); }
export function isStartArchiveRequest(v: unknown): v is StartArchiveRequest { return record(v) && keys(v, [...selectionKeys,'commandId','proposalFingerprint','userConfirmed']) && selected(v) && isCollectionId(v.commandId) && hash(v.proposalFingerprint) && v.userConfirmed === true; }
export function isArchiveObjectDescriptor(v: unknown): v is ArchiveObjectDescriptor {
  return record(v) && keys(v, ['role','name','sha256','size','media']) && typeof v.role === 'string' && ['execution-audio','conversion-intermediate','raw-render','exact-source','manifest','metadata'].includes(v.role) && name(v.name) && hash(v.sha256) && (v.media === 'audio' || v.media === 'json') && ['manifest','metadata'].includes(v.role) === (v.media === 'json') && integer(v.size, 1, v.media === 'json' ? 4 * 1024 * 1024 : 68_719_476_736);
}
/** 同内容多角色仅计一份复制预算；同 Hash 异长度不是可接受的去重事实。 */
export function archiveObjectTotals(files: readonly ArchiveObjectDescriptor[]): { objectCount: number; copyBytes: number } | undefined {
  const objects = new Map<string, number>(), names = new Set<string>();
  for (const f of files) {
    if (!isArchiveObjectDescriptor(f) || names.has(`${f.role}:${f.name}`) || objects.has(f.sha256) && objects.get(f.sha256) !== f.size) return undefined;
    names.add(`${f.role}:${f.name}`); objects.set(f.sha256, f.size);
  }
  const copyBytes = [...objects.values()].reduce((n, size) => n + size, 0);
  return integer(copyBytes, 1, 1_099_511_627_776) ? { objectCount: objects.size, copyBytes } : undefined;
}
export function isArchiveProposal(v: unknown): v is ArchiveProposal {
  if (!record(v) || !keys(v, [...selectionKeys,'draftId','masterVersionId','layoutVersionId','mode','preparedVersionId','files','objectCount','copyBytes','requiredBytes','availableBytes','proposalFingerprint','retentionPolicy','formalReady']) || !selected(v) || !['draftId','masterVersionId','layoutVersionId'].every(k => isCollectionId(v[k])) || !Array.isArray(v.files) || v.files.length < 3 || v.files.length > 1000 || !v.files.every(isArchiveObjectDescriptor) || !hash(v.proposalFingerprint) || v.retentionPolicy !== 'unresolved-no-automatic-deletion' || v.formalReady !== false || !integer(v.availableBytes)) return false;
  const totals = archiveObjectTotals(v.files); if (!totals || v.objectCount !== totals.objectCount || v.copyBytes !== totals.copyBytes || v.requiredBytes !== totals.copyBytes + ARCHIVE_SPACE_RESERVE) return false;
  const files = v.files, roles = new Set(files.map(f => f.role));
  if (!roles.has('execution-audio') || !roles.has('manifest') || !roles.has('metadata') || roles.has('exact-source') !== (v.sourcePolicy === 'preserve-exact-sources')) return false;
  if (v.mode === 'direct' || v.mode === 'direct-converted') return v.preparedVersionId === undefined && !roles.has('raw-render') && roles.has('conversion-intermediate') === (v.mode === 'direct-converted');
  if (v.mode !== 'prepared-reference' && v.mode !== 'prepared-derivative' || !isCollectionId(v.preparedVersionId) || !roles.has('raw-render') || roles.has('conversion-intermediate') || files.filter(f => f.role === 'manifest').length < 2) return false;
  return v.mode !== 'prepared-reference' || files.filter(f => f.role === 'execution-audio').every(f => files.some(raw => raw.role === 'raw-render' && raw.sha256 === f.sha256 && raw.size === f.size));
}
export function isArchiveOperationView(v: unknown): v is ArchiveOperationView {
  return record(v) && keys(v, [...selectionKeys,'id','draftId','masterVersionId','layoutVersionId','phase','active','issue','objectCount','copyBytes','createdAt','formalReady']) && selected(v) && ['id','draftId','masterVersionId','layoutVersionId'].every(k => isCollectionId(v[k])) && typeof v.phase === 'string' && ['REQUESTED','INTENT_WRITTEN','STAGED','VERIFIED','PROMOTED','DB_COMMITTED','FINALIZED'].includes(v.phase) && typeof v.active === 'boolean' && (v.issue === undefined || issue(v.issue)) && integer(v.objectCount, 1, 1000) && integer(v.copyBytes, 1, 1_099_511_627_776) && date(v.createdAt) && v.formalReady === false;
}
export function isArchiveHistory(v: unknown): v is ArchiveHistory {
  return record(v) && keys(v, ['draftId','operations']) && isCollectionId(v.draftId) && Array.isArray(v.operations) && v.operations.length <= 1000 && v.operations.every(isArchiveOperationView) && v.operations.every(op => op.draftId === v.draftId) && new Set(v.operations.map(op => op.id)).size === v.operations.length;
}
export function isVerifyArchiveRequest(v: unknown): v is VerifyArchiveRequest { return record(v) && keys(v, ['id','readId']) && isCollectionId(v.id) && isCollectionId(v.readId); }
export function isArchiveCheck(v: unknown): v is ArchiveCheck { return record(v) && keys(v, ['id','state','checkedAt','reason','formalReady']) && isCollectionId(v.id) && date(v.checkedAt) && v.formalReady === false && (v.state === 'verified' ? v.reason === undefined : v.state === 'unavailable' && issue(v.reason)); }
