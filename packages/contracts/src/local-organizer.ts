import { isCollectionId } from './collection.js';
import { isLocalCatalogRevision, isLocalCatalogText, isLocalMetadata, isLocalMetadataAnnotations, type LocalMetadata, type LocalMetadataAnnotations, type LocalGroupingSuggestion } from './local-catalog.js';

export const LOCAL_ORGANIZER_LIMIT = 100;
export const LOCAL_ORGANIZER_BYTES = 2 * 1024 * 1024;
export const LOCAL_ORGANIZER_FIELDS = ['title', 'artist', 'album', 'year', 'disc', 'track'] as const;
export type LocalOrganizerScope = 'MB_ONLY' | 'SOURCE_FILES';
export type OrganizerFieldChange = { action: 'set'; value: string } | { action: 'clear' };
export interface LocalOrganizerPatch {
  fields: Partial<Record<typeof LOCAL_ORGANIZER_FIELDS[number], OrganizerFieldChange>>;
  annotations?: { versionDescription?: OrganizerFieldChange; groupingSuggestions?: { action: 'set'; value: LocalGroupingSuggestion[] } | { action: 'clear' } };
}
export type LocalOrganizerTarget = { mode: 'single'; trackId: string } | { mode: 'edition'; editionId: string } | { mode: 'batch'; trackIds: string[] };
/** 以下body六键及operation九键沿用冻结v1.2；运行时CAS在独立指纹中。 */
export interface OrganizerFrozenPatch {
  title?: string | null; album?: string | null; album_artist?: string | null; date?: string | null;
  edition_note?: string | null; artwork_selection_id?: string | null; artists?: string[] | null; genres?: string[] | null;
  track_number?: number | null; disc_number?: number | null;
}
export interface OrganizerFrozenOperation {
  operation_id: string; kind: 'MB_OVERRIDE' | 'SELECT_COVER_MB' | 'WRITE_COVER' | 'WRITE_TAGS' | 'RENAME' | 'MOVE';
  root_id: string; target_asset_id: string; expected_asset_revision: string;
  source_relative_path: string; target_relative_path: string | null; field_patch: OrganizerFrozenPatch; backup_required: boolean;
}
export interface OrganizerFrozenBody {
  created_at: string; scope: LocalOrganizerScope; operations: OrganizerFrozenOperation[];
  root_mapping_revisions: Record<string, string>; conflicts: string[];
  resource_guards: { require_exclusive_asset_lock: boolean; defer_if_read_lease: boolean; protect_frozen_sources: true; recheck_at_execution: true };
}
export interface OrganizerOverlay { fields: LocalMetadata; annotations: LocalMetadataAnnotations }
export interface LocalOrganizerItem {
  operation: OrganizerFrozenOperation; trackId: string; selectionRevision: string; rootRevision: string; locationRevision: string;
  overrideRevision: string | null; raw: LocalMetadata; before: OrganizerOverlay; after: OrganizerOverlay;
  permission: { sourceRootId: string; authorized: boolean; dev: string; ino: string };
  sourceObservation: { status: 'observed' | 'unknown'; fileSignature: string | null; permissionMode: string | null; rootPermissionMode: string | null; directoryIds: string[] };
  protection: { resources: string[]; complete: boolean; activeLease: 'not-applicable' | 'unknown'; frozenReferences: 'not-applicable' | 'unknown'; writable: 'not-applicable' | 'unknown'; backupBytes: string | null };
}
export type LocalOrganizerState = 'DRAFT' | 'BLOCKED' | 'CONFIRMED' | 'EXECUTING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'RECOVERY_REQUIRED' | 'ROLLED_BACK';
export interface LocalOrganizerItemResult { operationId: string; trackId: string; state: 'planned' | 'applied' | 'not-written' | 'unknown'; overrideRevision: string | null; issue: string | null }
export interface LocalOrganizerPlan {
  planId: string; revision: string; datasetId: string; scope: LocalOrganizerScope; planHash: string; contextFingerprint: string;
  createdAt: string; expiresAt: string; body: OrganizerFrozenBody; items: LocalOrganizerItem[];
  editionBindings: { editionId: string; revision: string }[]; state: LocalOrganizerState; issue: string | null;
  results: LocalOrganizerItemResult[]; undoOf: string | null;
}
export interface PreviewLocalOrganizer { commandId: string; scope: LocalOrganizerScope; target: LocalOrganizerTarget; patch: LocalOrganizerPatch }
export interface ConfirmLocalOrganizer { commandId: string; planId: string; expectedRevision: string; scope: LocalOrganizerScope; planHash: string; contextFingerprint: string }
export interface ChangeLocalOrganizer { commandId: string; planId: string; expectedRevision: string }
export interface LocalOrganizerCommandPayloads {
  'localOrganizer.preview': PreviewLocalOrganizer;
  'localOrganizer.get': { planId: string };
  'localOrganizer.history': { offset: number; limit: number };
  'localOrganizer.confirm': ConfirmLocalOrganizer;
  'localOrganizer.undo': ChangeLocalOrganizer;
  'localOrganizer.cancel': ChangeLocalOrganizer;
}
export interface LocalOrganizerCommandResults {
  'localOrganizer.preview': LocalOrganizerPlan; 'localOrganizer.get': LocalOrganizerPlan;
  'localOrganizer.history': { offset: number; limit: number; total: number; items: { planId: string; revision: string; scope: LocalOrganizerScope; state: LocalOrganizerState; createdAt: string; count: number; issue: string | null }[] };
  'localOrganizer.confirm': LocalOrganizerPlan; 'localOrganizer.undo': LocalOrganizerPlan; 'localOrganizer.cancel': LocalOrganizerPlan;
}
export const LOCAL_ORGANIZER_COMMANDS = ['localOrganizer.preview', 'localOrganizer.get', 'localOrganizer.history', 'localOrganizer.confirm', 'localOrganizer.undo', 'localOrganizer.cancel'] as const;
export type LocalOrganizerCommand = keyof LocalOrganizerCommandPayloads;
export interface LocalOrganizerPublicApi {
  previewLocalOrganizer(request: PreviewLocalOrganizer): Promise<LocalOrganizerPlan>;
  getLocalOrganizerPlan(request: { planId: string }): Promise<LocalOrganizerPlan>;
  listLocalOrganizerHistory(request: { offset: number; limit: number }): Promise<LocalOrganizerCommandResults['localOrganizer.history']>;
  confirmLocalOrganizer(request: ConfirmLocalOrganizer): Promise<LocalOrganizerPlan>;
  undoLocalOrganizer(request: ChangeLocalOrganizer): Promise<LocalOrganizerPlan>;
  cancelLocalOrganizer(request: ChangeLocalOrganizer): Promise<LocalOrganizerPlan>;
}

/** 在读取属性或clone之前检查闭集数据描述符。 */
export function organizerRecord(v: unknown, required: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  return required.every(k => Object.hasOwn(v, k)) && Reflect.ownKeys(v).every(k => typeof k === 'string' && [...required, ...optional].includes(k)
    && Object.getOwnPropertyDescriptor(v, k)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
}
export function organizerArray(v: unknown, max: number): v is unknown[] {
  return Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= max && Reflect.ownKeys(v).length === v.length + 1
    && Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, String(i))).every(d => d?.enumerable === true && Object.hasOwn(d, 'value'));
}
const scope = (v: unknown): v is LocalOrganizerScope => v === 'MB_ONLY' || v === 'SOURCE_FILES';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const relative = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f\\:]/u.test(v)
  && !v.startsWith('/') && v.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const state = (v: unknown): v is LocalOrganizerState => typeof v === 'string' && ['DRAFT', 'BLOCKED', 'CONFIRMED', 'EXECUTING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED', 'ROLLED_BACK'].includes(v);
const issue = (v: unknown): v is string | null => v === null || typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(v);
const metadata = (v: unknown): v is LocalMetadata => organizerRecord(v, [], LOCAL_ORGANIZER_FIELDS) && isLocalMetadata(v);
const overlay = (v: unknown): v is OrganizerOverlay => organizerRecord(v, ['fields', 'annotations']) && metadata(v.fields) && isLocalMetadataAnnotations(v.annotations);
const change = (v: unknown): v is OrganizerFieldChange => organizerRecord(v, ['action']) && v.action === 'clear'
  || organizerRecord(v, ['action', 'value']) && v.action === 'set' && isLocalCatalogText(v.value, true);
export function isLocalOrganizerPatch(v: unknown): v is LocalOrganizerPatch {
  if (!organizerRecord(v, ['fields'], ['annotations']) || !organizerRecord(v.fields, [], LOCAL_ORGANIZER_FIELDS) || !Object.values(v.fields).every(change)) return false;
  if (Object.hasOwn(v, 'annotations')) {
    if (!organizerRecord(v.annotations, [], ['versionDescription', 'groupingSuggestions'])) return false;
    if (Object.hasOwn(v.annotations, 'versionDescription') && !change(v.annotations.versionDescription)) return false;
    if (Object.hasOwn(v.annotations, 'groupingSuggestions')) {
      const c = v.annotations.groupingSuggestions;
      if (!(organizerRecord(c, ['action']) && c.action === 'clear' || organizerRecord(c, ['action', 'value']) && c.action === 'set' && isLocalMetadataAnnotations({ groupingSuggestions: c.value }))) return false;
    }
  }
  return Object.keys(v.fields).length + (Object.hasOwn(v, 'annotations') ? Object.keys(v.annotations as object).length : 0) > 0;
}
export function isLocalOrganizerTarget(v: unknown): v is LocalOrganizerTarget {
  return organizerRecord(v, ['mode', 'trackId']) && v.mode === 'single' && isCollectionId(v.trackId)
    || organizerRecord(v, ['mode', 'editionId']) && v.mode === 'edition' && isCollectionId(v.editionId)
    || organizerRecord(v, ['mode', 'trackIds']) && v.mode === 'batch' && organizerArray(v.trackIds, LOCAL_ORGANIZER_LIMIT) && v.trackIds.length > 0
      && v.trackIds.every(isCollectionId) && new Set(v.trackIds).size === v.trackIds.length;
}
export function isOrganizerFrozenOperation(v: unknown): v is OrganizerFrozenOperation {
  if (!organizerRecord(v, ['operation_id', 'kind', 'root_id', 'target_asset_id', 'expected_asset_revision', 'source_relative_path', 'target_relative_path', 'field_patch', 'backup_required'])
    || ![v.operation_id, v.root_id, v.target_asset_id].every(isCollectionId) || !isLocalCatalogRevision(v.expected_asset_revision) || !relative(v.source_relative_path)
    || !(v.target_relative_path === null || relative(v.target_relative_path)) || typeof v.backup_required !== 'boolean'
    || typeof v.kind !== 'string' || !['MB_OVERRIDE', 'SELECT_COVER_MB', 'WRITE_COVER', 'WRITE_TAGS', 'RENAME', 'MOVE'].includes(v.kind)) return false;
  if (!organizerRecord(v.field_patch, [], ['title', 'album', 'album_artist', 'date', 'edition_note', 'artwork_selection_id', 'artists', 'genres', 'track_number', 'disc_number'])) return false;
  if (['RENAME', 'MOVE'].includes(v.kind) && v.target_relative_path === null || ['MB_OVERRIDE', 'SELECT_COVER_MB', 'WRITE_COVER', 'WRITE_TAGS'].includes(v.kind) && Object.keys(v.field_patch).length === 0) return false;
  return Object.entries(v.field_patch).every(([k, value]) => {
    if (value === null) return true;
    if (['artists', 'genres'].includes(k)) return organizerArray(value, 32) && value.every(x => typeof x === 'string' && x.length > 0 && x.length <= 1024);
    if (['track_number', 'disc_number'].includes(k)) return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000;
    return typeof value === 'string' && value.length <= 4096;
  });
}
export function isOrganizerFrozenBody(v: unknown): v is OrganizerFrozenBody {
  if (!organizerRecord(v, ['created_at', 'scope', 'operations', 'root_mapping_revisions', 'conflicts', 'resource_guards']) || !date(v.created_at) || !scope(v.scope)
    || !organizerArray(v.operations, LOCAL_ORGANIZER_LIMIT) || !v.operations.length || !v.operations.every(isOrganizerFrozenOperation)
    || new Set(v.operations.map(o => o.operation_id)).size !== v.operations.length
    || !organizerRecord(v.root_mapping_revisions, [], Object.keys(v.root_mapping_revisions as object || {})) || Object.keys(v.root_mapping_revisions).length < 1 || Object.keys(v.root_mapping_revisions).length > 100
    || !Object.entries(v.root_mapping_revisions).every(([k, r]) => isCollectionId(k) && isLocalCatalogRevision(r))
    || !organizerArray(v.conflicts, 100) || !v.conflicts.every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096)
    || !organizerRecord(v.resource_guards, ['require_exclusive_asset_lock', 'defer_if_read_lease', 'protect_frozen_sources', 'recheck_at_execution'])
    || v.resource_guards.protect_frozen_sources !== true || v.resource_guards.recheck_at_execution !== true) return false;
  const source = v.scope === 'SOURCE_FILES';
  const roots = v.root_mapping_revisions;
  return v.resource_guards.require_exclusive_asset_lock === source && v.resource_guards.defer_if_read_lease === source
    && v.operations.every(o => o.backup_required === source && (source ? ['WRITE_COVER', 'WRITE_TAGS', 'RENAME', 'MOVE'] : ['MB_OVERRIDE', 'SELECT_COVER_MB']).includes(o.kind) && Object.hasOwn(roots, o.root_id));
}
export function isLocalOrganizerItem(v: unknown): v is LocalOrganizerItem {
  return organizerRecord(v, ['operation', 'trackId', 'selectionRevision', 'rootRevision', 'locationRevision', 'overrideRevision', 'raw', 'before', 'after', 'permission', 'sourceObservation', 'protection'])
    && isOrganizerFrozenOperation(v.operation) && isCollectionId(v.trackId) && [v.selectionRevision, v.rootRevision, v.locationRevision].every(isLocalCatalogRevision)
    && (v.overrideRevision === null || isLocalCatalogRevision(v.overrideRevision)) && metadata(v.raw) && overlay(v.before) && overlay(v.after)
    && organizerRecord(v.permission, ['sourceRootId', 'authorized', 'dev', 'ino']) && isCollectionId(v.permission.sourceRootId) && typeof v.permission.authorized === 'boolean'
    && [v.permission.dev, v.permission.ino].every(n => typeof n === 'string' && /^(0|[1-9][0-9]*)$/u.test(n) && n.length <= 32)
    && organizerRecord(v.sourceObservation, ['status', 'fileSignature', 'permissionMode', 'rootPermissionMode', 'directoryIds'])
    && (v.sourceObservation.status === 'observed' || v.sourceObservation.status === 'unknown')
    && (v.sourceObservation.status === 'observed'
      ? typeof v.sourceObservation.fileSignature === 'string' && /^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+:-?[0-9]+$/u.test(v.sourceObservation.fileSignature) && v.sourceObservation.fileSignature.length <= 256
        && [v.sourceObservation.permissionMode, v.sourceObservation.rootPermissionMode].every(n => typeof n === 'string' && /^(0|[1-9][0-9]*)$/u.test(n) && n.length <= 10)
      : v.sourceObservation.fileSignature === null && v.sourceObservation.permissionMode === null && v.sourceObservation.rootPermissionMode === null)
    && organizerArray(v.sourceObservation.directoryIds, 128) && v.sourceObservation.directoryIds.every(n => typeof n === 'string' && /^[0-9]+:[0-9]+$/u.test(n) && n.length <= 65)
    && organizerRecord(v.protection, ['resources', 'complete', 'activeLease', 'frozenReferences', 'writable', 'backupBytes'])
    && organizerArray(v.protection.resources, 128) && v.protection.resources.every(relative) && typeof v.protection.complete === 'boolean'
    && [v.protection.activeLease, v.protection.frozenReferences, v.protection.writable].every(x => x === 'not-applicable' || x === 'unknown')
    && (v.protection.backupBytes === null || typeof v.protection.backupBytes === 'string' && /^(0|[1-9][0-9]*)$/u.test(v.protection.backupBytes));
}
export function isLocalOrganizerPlan(v: unknown): v is LocalOrganizerPlan {
  if (!organizerRecord(v, ['planId', 'revision', 'datasetId', 'scope', 'planHash', 'contextFingerprint', 'createdAt', 'expiresAt', 'body', 'items', 'editionBindings', 'state', 'issue', 'results', 'undoOf'])
    || !isCollectionId(v.planId) || !isCollectionId(v.datasetId) || !isLocalCatalogRevision(v.revision) || !scope(v.scope) || !hash(v.planHash) || !hash(v.contextFingerprint)
    || !date(v.createdAt) || !date(v.expiresAt) || Date.parse(v.expiresAt) <= Date.parse(v.createdAt) || !isOrganizerFrozenBody(v.body)
    || v.body.scope !== v.scope || v.body.created_at !== v.createdAt || !organizerArray(v.items, 100) || v.items.length !== v.body.operations.length || !v.items.every(isLocalOrganizerItem)
    || new Set(v.items.map(i => i.trackId)).size !== v.items.length || !v.items.every((i, n) => equalJson(i.operation, (v.body as OrganizerFrozenBody).operations[n]))
    || !organizerArray(v.editionBindings, 100) || !v.editionBindings.every(e => organizerRecord(e, ['editionId', 'revision']) && isCollectionId(e.editionId) && isLocalCatalogRevision(e.revision))
    || new Set(v.editionBindings.map(e => (e as { editionId: string }).editionId)).size !== v.editionBindings.length
    || !state(v.state) || !issue(v.issue) || !(v.undoOf === null || isCollectionId(v.undoOf)) || !organizerArray(v.results, 100) || v.results.length !== v.items.length) return false;
  return v.results.every((r, n) => organizerRecord(r, ['operationId', 'trackId', 'state', 'overrideRevision', 'issue']) && r.operationId === (v.items as LocalOrganizerItem[])[n]!.operation.operation_id
    && r.trackId === (v.items as LocalOrganizerItem[])[n]!.trackId && typeof r.state === 'string' && ['planned', 'applied', 'not-written', 'unknown'].includes(r.state) && (r.overrideRevision === null || isLocalCatalogRevision(r.overrideRevision)) && issue(r.issue))
    && new TextEncoder().encode(JSON.stringify(v)).byteLength <= LOCAL_ORGANIZER_BYTES;
}
function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, n) => equalJson(v, b[n]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equalJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
export const isLocalOrganizerCommand = (v: unknown): v is LocalOrganizerCommand => typeof v === 'string' && (LOCAL_ORGANIZER_COMMANDS as readonly string[]).includes(v);
export function isLocalOrganizerCommandPayload<C extends LocalOrganizerCommand>(command: C, v: unknown): v is LocalOrganizerCommandPayloads[C] {
  switch (command) {
    case 'localOrganizer.preview': return organizerRecord(v, ['commandId', 'scope', 'target', 'patch']) && isCollectionId(v.commandId) && scope(v.scope) && isLocalOrganizerTarget(v.target) && isLocalOrganizerPatch(v.patch);
    case 'localOrganizer.get': return organizerRecord(v, ['planId']) && isCollectionId(v.planId);
    case 'localOrganizer.history': return organizerRecord(v, ['offset', 'limit']) && Number.isSafeInteger(v.offset) && Number(v.offset) >= 0 && Number.isSafeInteger(v.limit) && Number(v.limit) > 0 && Number(v.limit) <= 100;
    case 'localOrganizer.confirm': return organizerRecord(v, ['commandId', 'planId', 'expectedRevision', 'scope', 'planHash', 'contextFingerprint']) && isCollectionId(v.commandId) && isCollectionId(v.planId) && isLocalCatalogRevision(v.expectedRevision) && scope(v.scope) && hash(v.planHash) && hash(v.contextFingerprint);
    case 'localOrganizer.undo': case 'localOrganizer.cancel': return organizerRecord(v, ['commandId', 'planId', 'expectedRevision']) && isCollectionId(v.commandId) && isCollectionId(v.planId) && isLocalCatalogRevision(v.expectedRevision);
  }
}
export function isLocalOrganizerCommandResult<C extends LocalOrganizerCommand>(command: C, v: unknown): v is LocalOrganizerCommandResults[C] {
  if (command !== 'localOrganizer.history') return isLocalOrganizerPlan(v);
  return organizerRecord(v, ['offset', 'limit', 'total', 'items']) && isLocalOrganizerCommandPayload('localOrganizer.history', { offset: v.offset, limit: v.limit }) && Number.isSafeInteger(v.total) && Number(v.total) >= 0
    && organizerArray(v.items, Number(v.limit)) && v.items.every(p => organizerRecord(p, ['planId', 'revision', 'scope', 'state', 'createdAt', 'count', 'issue']) && isCollectionId(p.planId) && isLocalCatalogRevision(p.revision) && scope(p.scope) && state(p.state) && date(p.createdAt) && Number.isSafeInteger(p.count) && Number(p.count) > 0 && Number(p.count) <= 100 && issue(p.issue));
}
