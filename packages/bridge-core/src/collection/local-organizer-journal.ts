import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';

/** 私有事件复用31版账本；既有十二类目录回执仍按原规则重放。 */
export const ORGANIZER_JOURNAL = 'organizer-journal-v1';
export const ORGANIZER_MAX_REVISIONS = 32;
type Plan = dto.LocalOrganizerPlan;
export type OrganizerHeader = Omit<Plan, 'body' | 'items' | 'results' | 'revision' | 'state' | 'issue'> & {
  body: Omit<dto.OrganizerFrozenBody, 'operations'>; count: number; initialState: 'DRAFT' | 'BLOCKED'; initialIssue: string | null;
};
interface Base { version: 1; eventId: string; planId: string }
export type OrganizerEvent = Base & (
  { kind: 'item'; index: number; item: dto.LocalOrganizerItem }
  | { kind: 'proposed'; header: OrganizerHeader; action: 'preview'; request: dto.PreviewLocalOrganizer }
  | { kind: 'proposed'; header: OrganizerHeader; action: 'undo'; request: dto.ChangeLocalOrganizer }
  | { kind: 'decision'; action: 'confirm'; request: dto.ConfirmLocalOrganizer; revision: string }
  | { kind: 'decision'; action: 'cancel'; request: dto.ChangeLocalOrganizer; revision: string }
  | { kind: 'state'; revision: string; state: dto.LocalOrganizerState; issue: string | null; decisionId: string | null; relatedPlanId: string | null }
  | { kind: 'item-applied'; index: number; decisionId: string; operationId: string; overrideRevision: string }
);
type Row = Record<string, unknown>;
const fail = (): never => { throw new Error('整理计划或私有历史损坏，保留现有工作库。'); };
const codePointCompare = (a: string, b: string): number => {
  const aa = Array.from(a, c => c.codePointAt(0)!), bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
};
/** 冻结UTF8 canonical：码点排序、无NFC、仅安全整数，拒绝getter、稀疏数组和非JSON值。 */
export function organizerCanonical(value: unknown): string {
  let nodes = 0;
  const string = (v: string): string => { if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) return fail(); return JSON.stringify(v); };
  function walk(v: unknown, depth: number): string {
    if (++nodes > 50_000 || depth > 32) return fail();
    if (v === null) return 'null';
    if (typeof v === 'string') return string(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' && Number.isSafeInteger(v)) return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (!dto.organizerArray(v, 10_000)) return fail();
      return `[${v.map(x => walk(x, depth + 1)).join(',')}]`;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!dto.organizerRecord(v, [], keys)) return fail();
      return `{${keys.sort(codePointCompare).map(k => `${string(k)}:${walk((v as Row)[k], depth + 1)}`).join(',')}}`;
    }
    return fail();
  }
  const result = walk(value, 0); if (Buffer.byteLength(result) > dto.LOCAL_ORGANIZER_BYTES) return fail(); return result;
}
export const organizerHash = (v: unknown): string => createHash('sha256').update(organizerCanonical(v), 'utf8').digest('hex');
export const organizerEqual = (a: unknown, b: unknown): boolean => organizerCanonical(a) === organizerCanonical(b);
export function organizerId(planId: string, part: string): string {
  const h = createHash('sha256').update(`music-bridge/organizer/v1/${planId}/${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const organizerRevisionId = (planId: string, revision: string): string => revision === '1' ? planId : organizerId(planId, `state/${revision}`);
export function organizerApplyPatch(before: dto.OrganizerOverlay, patch: dto.LocalOrganizerPatch): dto.OrganizerOverlay {
  const result = structuredClone(before);
  for (const field of dto.LOCAL_ORGANIZER_FIELDS) {
    const change = patch.fields[field]; if (!change) continue;
    if (change.action === 'clear') delete result.fields[field]; else result.fields[field] = change.value;
  }
  const version = patch.annotations?.versionDescription;
  if (version?.action === 'clear') delete result.annotations.versionDescription; else if (version?.action === 'set') result.annotations.versionDescription = version.value;
  const groups = patch.annotations?.groupingSuggestions;
  if (groups?.action === 'clear') delete result.annotations.groupingSuggestions; else if (groups?.action === 'set') result.annotations.groupingSuggestions = structuredClone(groups.value);
  return result;
}
/** 完整override投影；null只表示撤销MB覆盖，不能解释为源标签写入。不可表示的文本留在运行时指纹。 */
export function organizerFrozenPatch(overlay: dto.OrganizerOverlay): dto.OrganizerFrozenPatch {
  const f = overlay.fields, patch: dto.OrganizerFrozenPatch = {
    title: f.title ?? null, album: f.album ?? null, artists: f.artist ? [f.artist] : null, date: f.year ?? null,
    edition_note: overlay.annotations.versionDescription ?? null,
  };
  for (const [field, key] of [['disc', 'disc_number'], ['track', 'track_number']] as const) {
    const v = f[field];
    if (v === undefined) patch[key] = null;
    else if (/^(0|[1-9][0-9]*)$/u.test(v) && Number(v) <= 100000) patch[key] = Number(v);
  }
  return patch;
}
export function organizerContextFingerprint(plan: Pick<Plan, 'datasetId' | 'createdAt' | 'expiresAt' | 'scope' | 'items' | 'editionBindings' | 'undoOf'>): string {
  return organizerHash({ runtime_version: 1, datasetId: plan.datasetId, createdAt: plan.createdAt, expiresAt: plan.expiresAt,
    scope: plan.scope, items: plan.items, editionBindings: plan.editionBindings, undoOf: plan.undoOf });
}
const issue = (v: unknown): boolean => v === null || typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(v);
function isHeader(v: unknown): v is OrganizerHeader {
  return dto.organizerRecord(v, ['planId', 'datasetId', 'scope', 'planHash', 'contextFingerprint', 'createdAt', 'expiresAt', 'body', 'editionBindings', 'undoOf', 'count', 'initialState', 'initialIssue'])
    && dto.isCollectionId(v.planId) && dto.isCollectionId(v.datasetId) && Number.isSafeInteger(v.count) && Number(v.count) > 0 && Number(v.count) <= 100
    && (v.initialState === 'DRAFT' || v.initialState === 'BLOCKED') && issue(v.initialIssue)
    && dto.organizerRecord(v.body, ['created_at', 'scope', 'root_mapping_revisions', 'conflicts', 'resource_guards']);
}
export function isOrganizerEvent(v: unknown): v is OrganizerEvent {
  if (!dto.organizerRecord(v, ['version', 'eventId', 'planId', 'kind'], ['index', 'item', 'header', 'action', 'request', 'revision', 'state', 'issue', 'decisionId', 'relatedPlanId', 'operationId', 'overrideRevision'])
    || v.version !== 1 || !dto.isCollectionId(v.eventId) || !dto.isCollectionId(v.planId)) return false;
  const closed = (...keys: string[]): boolean => dto.organizerRecord(v, ['version', 'eventId', 'planId', 'kind', ...keys]);
  const ordinal = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < 100;
  switch (v.kind) {
    case 'item': return closed('index', 'item') && ordinal(v.index) && dto.isLocalOrganizerItem(v.item) && v.eventId === organizerId(v.planId, `item/${v.index}`);
    case 'proposed': return closed('header', 'action', 'request') && isHeader(v.header) && v.header.planId === v.planId && v.eventId === v.planId
      && (v.action === 'preview' && dto.isLocalOrganizerCommandPayload('localOrganizer.preview', v.request) || v.action === 'undo' && dto.isLocalOrganizerCommandPayload('localOrganizer.undo', v.request)) && (v.request as { commandId: string }).commandId === v.planId;
    case 'decision': return closed('action', 'request', 'revision') && dto.isLocalCatalogRevision(v.revision)
      && (v.action === 'confirm' && dto.isLocalOrganizerCommandPayload('localOrganizer.confirm', v.request) || v.action === 'cancel' && dto.isLocalOrganizerCommandPayload('localOrganizer.cancel', v.request))
      && (v.request as dto.ChangeLocalOrganizer).commandId === v.eventId && (v.request as dto.ChangeLocalOrganizer).planId === v.planId;
    case 'state': return closed('revision', 'state', 'issue', 'decisionId', 'relatedPlanId') && dto.isLocalCatalogRevision(v.revision) && Number(v.revision) >= 2 && Number(v.revision) <= ORGANIZER_MAX_REVISIONS
      && v.eventId === organizerRevisionId(v.planId, v.revision) && typeof v.state === 'string' && ['CONFIRMED', 'EXECUTING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED', 'ROLLED_BACK'].includes(v.state)
      && issue(v.issue) && (v.decisionId === null || dto.isCollectionId(v.decisionId)) && (v.relatedPlanId === null || dto.isCollectionId(v.relatedPlanId));
    case 'item-applied': return closed('index', 'decisionId', 'operationId', 'overrideRevision') && ordinal(v.index) && dto.isCollectionId(v.decisionId) && dto.isCollectionId(v.operationId) && dto.isLocalCatalogRevision(v.overrideRevision)
      && v.eventId === organizerId(v.planId, `applied/${v.index}`);
    default: return false;
  }
}
export function readOrganizerEvent(row: Row): OrganizerEvent {
  if (row.operation !== ORGANIZER_JOURNAL || typeof row.request !== 'string' || typeof row.result !== 'string' || Buffer.byteLength(row.request) + Buffer.byteLength(row.result) > 64 * 1024) return fail();
  const event: unknown = JSON.parse(row.request), ack: unknown = JSON.parse(row.result);
  if (row.request !== organizerCanonical(event) || row.result !== organizerCanonical(ack) || !isOrganizerEvent(event) || row.command_id !== event.eventId || row.fingerprint !== organizerHash(event)
    || !dto.organizerRecord(ack, ['eventId', 'eventHash']) || ack.eventId !== event.eventId || ack.eventHash !== row.fingerprint
    || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return fail();
  return event;
}
export function organizerEvent(db: DatabaseSync, id: string): OrganizerEvent | undefined {
  const row = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(id); return row ? readOrganizerEvent(row) : undefined;
}
export function organizerProposal(db: DatabaseSync, planId: string): Extract<OrganizerEvent, { kind: 'proposed' }> {
  const event = organizerEvent(db, planId); return event?.kind === 'proposed' ? event : fail();
}
export function organizerInitialPlan(db: DatabaseSync, proposed: Extract<OrganizerEvent, { kind: 'proposed' }>): Plan {
  const h = proposed.header, items: dto.LocalOrganizerItem[] = [];
  for (let i = 0; i < h.count; i++) {
    const event = organizerEvent(db, organizerId(h.planId, `item/${i}`));
    if (event?.kind !== 'item' || event.planId !== h.planId || event.index !== i) return fail(); items.push(event.item);
  }
  const { count: _count, initialState, initialIssue, ...header } = h;
  const plan: Plan = { ...header, revision: '1', state: initialState, issue: initialIssue, items,
    body: { ...h.body, operations: items.map(i => i.operation) }, results: items.map(i => ({ operationId: i.operation.operation_id, trackId: i.trackId, state: 'planned', overrideRevision: null, issue: null })) };
  if (!dto.isLocalOrganizerPlan(plan) || organizerHash(plan.body) !== plan.planHash || organizerContextFingerprint(plan) !== plan.contextFingerprint
    || items.some((item, index) => item.operation.operation_id !== organizerId(plan.planId, `operation/${index}`) || !organizerEqual(item.operation.field_patch, organizerFrozenPatch(item.after)))
    || !organizerEqual(plan.body.root_mapping_revisions, Object.fromEntries(items.map(item => [item.operation.root_id, item.rootRevision])))
    || items.some(item => plan.scope === 'MB_ONLY' ? !organizerEqual(item.protection, { resources: [], complete: true, activeLease: 'not-applicable', frozenReferences: 'not-applicable', writable: 'not-applicable', backupBytes: null })
      : !organizerEqual(item.protection, { resources: [item.operation.source_relative_path], complete: false, activeLease: 'unknown', frozenReferences: 'unknown', writable: 'unknown', backupBytes: null }))
    || initialState !== (plan.scope === 'SOURCE_FILES' ? 'BLOCKED' : 'DRAFT') || initialIssue !== (plan.scope === 'SOURCE_FILES' ? 'SOURCE_FILES_WRITE_OFF' : null)) return fail();
  return plan;
}
export function organizerCurrentPlan(db: DatabaseSync, planId: string): Plan {
  const plan = organizerInitialPlan(db, organizerProposal(db, planId));
  for (let r = 2; r <= ORGANIZER_MAX_REVISIONS; r++) {
    const event = organizerEvent(db, organizerRevisionId(planId, String(r))); if (!event) break;
    if (event.kind !== 'state' || event.planId !== planId || event.revision !== String(r)) return fail();
    plan.revision = event.revision; plan.state = event.state; plan.issue = event.issue;
  }
  for (let i = 0; i < plan.items.length; i++) {
    const event = organizerEvent(db, organizerId(planId, `applied/${i}`)); if (!event) continue;
    if (event.kind !== 'item-applied') return fail();
    plan.results[i] = { operationId: event.operationId, trackId: plan.items[i]!.trackId, state: 'applied', overrideRevision: event.overrideRevision, issue: null };
  }
  if (['FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(plan.state)) for (const result of plan.results) if (result.state === 'planned') { result.state = 'not-written'; result.issue = plan.issue; }
  if (!dto.isLocalOrganizerPlan(plan)) return fail(); return plan;
}
/** 历史页只水合有界状态与摘要；已有audit证书保证header曾完整验证，不重建100份大计划。 */
export function organizerPlanSummary(db: DatabaseSync, planId: string): dto.LocalOrganizerCommandResults['localOrganizer.history']['items'][number] & { datasetId: string } {
  const h = organizerProposal(db, planId).header;
  const summary = { datasetId: h.datasetId, planId: h.planId, revision: '1', scope: h.scope, state: h.initialState as dto.LocalOrganizerState, createdAt: h.createdAt, count: h.count, issue: h.initialIssue };
  for (let r = 2; r <= ORGANIZER_MAX_REVISIONS; r++) {
    const event = organizerEvent(db, organizerRevisionId(planId, String(r))); if (!event) break; if (event.kind !== 'state') return fail();
    summary.revision = event.revision; summary.state = event.state; summary.issue = event.issue;
  }
  return summary;
}
const transitions: Partial<Record<dto.LocalOrganizerState, readonly dto.LocalOrganizerState[]>> = {
  DRAFT: ['CONFIRMED', 'CANCELLED', 'FAILED'], BLOCKED: ['CANCELLED'], CONFIRMED: ['EXECUTING', 'FAILED', 'RECOVERY_REQUIRED', 'CANCELLED'],
  EXECUTING: ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'], RECOVERY_REQUIRED: ['CONFIRMED', 'CANCELLED', 'FAILED'], COMPLETED: ['ROLLED_BACK'],
};
function previousState(db: DatabaseSync, planId: string, revision: string): { state: dto.LocalOrganizerState; revision: string } {
  if (revision === '1') { const h = organizerProposal(db, planId).header; return { state: h.initialState, revision }; }
  const event = organizerEvent(db, organizerRevisionId(planId, revision)); return event?.kind === 'state' ? event : fail();
}
export function verifyOrganizerJournalRow(db: DatabaseSync, row: Row, latest?: ReadonlyMap<string, dto.LocalCatalogResult>): void {
  const event = readOrganizerEvent(row);
  if (event.kind === 'item') {
    const item = event.item;
    if (item.operation.operation_id !== organizerId(event.planId, `operation/${event.index}`)) return fail();
    // item先写、proposal后写；提交后不允许留下孤立的预览子事件。
    const proposed = organizerProposal(db, event.planId); if (event.index >= proposed.header.count) return fail(); return;
  }
  const proposal = event.kind === 'proposed' ? event : organizerProposal(db, event.planId);
  if (event.kind === 'item-applied') {
    const stored = organizerEvent(db, organizerId(event.planId, `item/${event.index}`));
    const item = stored?.kind === 'item' ? stored.item : fail(), decision = organizerEvent(db, event.decisionId), receipt = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(event.operationId);
    if (event.index >= proposal.header.count || item.operation.operation_id !== event.operationId || decision?.kind !== 'decision' || decision.action !== 'confirm' || decision.planId !== event.planId || !receipt || receipt.operation !== 'override-metadata') return fail();
    const request = JSON.parse(String(receipt.request)), result = JSON.parse(String(receipt.result));
    if (!organizerEqual(request, { commandId: event.operationId, trackId: item.trackId, expectedRevision: item.overrideRevision, fields: item.after.fields, annotations: item.after.annotations })
      || !dto.isLocalMetadataOverride(result) || result.trackId !== item.trackId || result.revision !== event.overrideRevision || !organizerEqual(result.fields, item.after.fields) || !organizerEqual(result.annotations ?? {}, item.after.annotations)) return fail(); return;
  }
  const plan = organizerInitialPlan(db, proposal);
  if (event.kind === 'proposed') {
    if (event.action === 'preview' && (event.request.scope !== plan.scope || plan.undoOf !== null)) return fail();
    if (event.action === 'undo' && (event.request.planId !== plan.undoOf || plan.scope !== 'MB_ONLY')) return fail();
    if (event.action === 'preview') {
      if (plan.items.some(item => !organizerEqual(item.after, organizerApplyPatch(item.before, event.request.patch)))) return fail();
      const target = event.request.target;
      if (target.mode === 'single' && (plan.items.length !== 1 || plan.items[0]!.trackId !== target.trackId)
        || target.mode === 'batch' && !organizerEqual(plan.items.map(item => item.trackId), target.trackIds)
        || target.mode === 'edition' && !plan.editionBindings.some(binding => binding.editionId === target.editionId)) return fail();
    } else {
      const original = organizerInitialPlan(db, organizerProposal(db, event.request.planId));
      if (previousState(db, original.planId, event.request.expectedRevision).state !== 'COMPLETED' || plan.items.length !== original.items.length
        || plan.items.some((item, i) => item.trackId !== original.items[i]!.trackId || !organizerEqual(item.after, original.items[i]!.before))) return fail();
    }
    if (latest) for (const item of plan.items) {
      const track = latest.get(`local_catalog_tracks:${item.trackId}`), asset = latest.get(`local_catalog_assets:${item.operation.target_asset_id}`), root = latest.get(`local_catalog_roots:${item.operation.root_id}`), override = latest.get(`local_catalog_overrides:${item.trackId}`);
      if (!dto.isLocalTrack(track) || !dto.isAudioAsset(asset) || !dto.isLibraryRoot(root) || track.assetId !== asset.id || track.selectionRevision !== item.selectionRevision
        || asset.fileRevision !== item.operation.expected_asset_revision || asset.locationRevision !== item.locationRevision || root.revision !== item.rootRevision || asset.libraryRootId !== root.id || root.sourceRootId !== item.permission.sourceRootId
        || (override && !dto.isLocalMetadataOverride(override)) || (override && dto.isLocalMetadataOverride(override) ? override.revision : null) !== item.overrideRevision
        || !organizerEqual({ fields: override && dto.isLocalMetadataOverride(override) ? override.fields : {}, annotations: override && dto.isLocalMetadataOverride(override) ? override.annotations ?? {} : {} }, item.before)) return fail();
    }
    return;
  }
  if (event.kind === 'decision') {
    const old = previousState(db, event.planId, event.request.expectedRevision), resulting = organizerEvent(db, organizerRevisionId(event.planId, event.revision));
    if (BigInt(event.request.expectedRevision) + 1n !== BigInt(event.revision) || resulting?.kind !== 'state' || resulting.decisionId !== event.eventId
      || !transitions[old.state]?.includes(resulting.state) || !(event.action === 'confirm' ? resulting.state === 'CONFIRMED' || resulting.state === 'FAILED' && resulting.issue !== null : resulting.state === 'CANCELLED')) return fail();
    if (event.action === 'confirm' && (plan.scope !== 'MB_ONLY' || event.request.scope !== plan.scope || event.request.planHash !== plan.planHash || event.request.contextFingerprint !== plan.contextFingerprint)) return fail(); return;
  }
  const old = previousState(db, event.planId, (BigInt(event.revision) - 1n).toString());
  if (!transitions[old.state]?.includes(event.state) || event.relatedPlanId !== null && event.state !== 'ROLLED_BACK') return fail();
  if (['CONFIRMED', 'EXECUTING', 'COMPLETED', 'ROLLED_BACK'].includes(event.state) && event.issue !== null
    || event.state === 'CANCELLED' && event.issue !== 'USER_CANCELLED' || ['FAILED', 'RECOVERY_REQUIRED'].includes(event.state) && event.issue === null) return fail();
  if (event.state === 'CONFIRMED' || event.state === 'CANCELLED') {
    const decision = event.decisionId ? organizerEvent(db, event.decisionId) : undefined;
    if (decision?.kind !== 'decision' || decision.planId !== event.planId || decision.revision !== event.revision || decision.action !== (event.state === 'CONFIRMED' ? 'confirm' : 'cancel')) return fail();
  }
  if (event.state === 'EXECUTING' || event.state === 'COMPLETED') {
    const decision = event.decisionId ? organizerEvent(db, event.decisionId) : undefined;
    if (decision?.kind !== 'decision' || decision.action !== 'confirm' || decision.planId !== event.planId) return fail();
    if (event.state === 'COMPLETED') for (let i = 0; i < plan.items.length; i++) {
      const effect = organizerEvent(db, organizerId(event.planId, `applied/${i}`)); if (effect?.kind !== 'item-applied' || effect.decisionId !== event.decisionId) return fail();
    }
  }
  if (event.state === 'ROLLED_BACK') {
    if (!event.relatedPlanId) return fail(); const inverse = organizerCurrentPlan(db, event.relatedPlanId);
    if (inverse.state !== 'COMPLETED' || inverse.undoOf !== event.planId || inverse.items.length !== plan.items.length || inverse.items.some((item, i) => item.trackId !== plan.items[i]!.trackId || !organizerEqual(item.after, plan.items[i]!.before))) return fail();
  }
}
