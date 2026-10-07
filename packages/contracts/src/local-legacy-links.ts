import { isCollectionId } from './collection.js';
import { isDigitalAlbumMetadata, type DigitalAlbumMetadata } from './physical-links.js';
import { isLocalCatalogRevision, isLocalTrackSegment, isLocalCatalogText, type LocalTrackSegment } from './local-catalog.js';

export const LOCAL_LEGACY_LINKS_COMMANDS = ['localLegacyLinks.read', 'localLegacyLinks.history', 'localLegacyLinks.preview', 'localLegacyLinks.confirm', 'localLegacyLinks.revoke', 'localLegacyLinks.undo'] as const;
export const LOCAL_LEGACY_LINKS_ISSUES = ['INVALID_REQUEST', 'DATASET_SCOPE_MISMATCH', 'NOT_FOUND', 'REVISION_CHANGED', 'LEFT_SLOT_CHANGED', 'PLAN_EXPIRED', 'PREVIEW_MISMATCH', 'COMMAND_ID_REUSED', 'SOURCE_OFFLINE', 'SOURCE_REVOKED', 'SOURCE_CHANGED', 'EXACT_HASH_REQUIRED', 'LEGACY_RANGE_UNKNOWN', 'SEGMENT_MISMATCH', 'UNDO_CONFLICT', 'REVISION_EXHAUSTED', 'CURSOR_SCOPE_MISMATCH', 'CURSOR_EXPIRED', 'BUDGET_EXCEEDED', 'RECOVERY_REQUIRED', 'INVENTORY_UNAVAILABLE'] as const;
export type LocalLegacyLinksIssue = typeof LOCAL_LEGACY_LINKS_ISSUES[number];
export const LOCAL_LEGACY_LINKS_BUDGET = Object.freeze({ requestDepth: 12, requestNodes: 2048, requestOwnKeys: 32, requestBytes: 16384, publicItems: 100, publicPageBytes: 2097152, edgeBytes: 8192, previewBytes: 16384, privateCaptureBytes: 16384, ledgerRowAllTextBytes: 65536, activeCursors: 128, cursorBytes: 512, cursorTtlMs: 600000, previewTtlMs: 600000, ioDeadlineMs: 120000, newDomainRows: 50000, projectionCanonicalBytes: 67108864, incrementalLedgerRowsPerRead: 512, cursorRetainedCanonicalBytesTotal: 16777216 });
export type LocalLegacyKey = { kind: 'physical-release'; physicalReleaseId: string } | { kind: 'digital-album'; digitalAlbumId: string } | { kind: 'draft-source'; draftId: string; draftTrackId: string; sourceBindingId: string };
export type LocalLegacyEditionSubject = { kind: 'physical-release'; physicalReleaseId: string; expectedRevision: number } | { kind: 'digital-album'; digitalAlbumId: string; expectedRevision: number };
export type LocalLegacyLocalKey = { kind: 'local-edition'; localEditionId: string } | { kind: 'local-track-asset'; localTrackId: string; assetId: string };
export type LocalLegacySelector = { by: 'link'; linkId: string } | { by: 'legacy'; key: LocalLegacyKey } | { by: 'local'; key: LocalLegacyLocalKey };
export interface LocalLegacySlotGuard { activeLinkId: string | null; lastTransitionEventId: string | null }
export type LocalLegacyLinkChoice =
  | { kind: 'legacy-edition'; subject: LocalLegacyEditionSubject; localEditionId: string; expectedEditionRevision: string; expectedSlot: LocalLegacySlotGuard }
  | { kind: 'draft-source-track'; draftId: string; draftTrackId: string; expectedDraftRevision: number; sourceBindingId: string; localTrackId: string; assetId: string; expectedSelectionRevision: string; expectedLibraryRootRevision: string; expectedFileRevision: string; expectedLocationRevision: string; expectedSegment: LocalTrackSegment | null; expectedSlot: LocalLegacySlotGuard };
export type LocalLegacyLinkIntent = { action: 'link'; choice: LocalLegacyLinkChoice } | { action: 'revoke'; linkId: string; expectedLinkRevision: string } | { action: 'undo'; linkId: string; expectedLinkRevision: string; undoTransitionEventId: string };
export interface ReadLocalLegacyLinks { datasetId: string; selector: LocalLegacySelector; state: 'active' | 'all'; cursor: string | null; limit: number }
export interface HistoryLocalLegacyLinks { datasetId: string; linkId: string; cursor: string | null; limit: number }
export interface PreviewLocalLegacyLink { datasetId: string; commandId: string; intent: LocalLegacyLinkIntent; reason: string }
export interface ExecuteLocalLegacyLink { datasetId: string; commandId: string; previewId: string; expectedPreviewRevision: string; previewHash: string; contextFingerprint: string; userConfirmed: true }
export type LocalLegacySubjectSnapshot =
  | { kind: 'digital-album'; digitalAlbumId: string; revision: number; metadata: DigitalAlbumMetadata }
  | { kind: 'physical-release'; physicalReleaseId: string; revision: number; summary: { format: 'cd' | 'cassette'; title: string; artist: string; year: number | null; edition: string | null }; releaseFingerprint: string };
export type LocalLegacyLinkEndpoints =
  | { kind: 'legacy-edition'; subject: LocalLegacySubjectSnapshot; localEditionId: string; editionRevision: string; title: string; edition: string }
  | { kind: 'draft-source-track'; draftId: string; draftTrackId: string; draftRevision: number; sourceBindingId: string; bindingRootId: string; localTrackId: string; assetId: string; selectionRevision: string; libraryRootId: string; sourceRootId: string; libraryRootRevision: string; assetRootRevision: string; fileRevision: string; locationRevision: string; segment: LocalTrackSegment | null };
export type LocalLegacyFileCoverage = { mode: 'whole-file' } | { mode: 'whole-file-span'; segment: LocalTrackSegment; sourceFrames: string; sourceTimebaseHz: number };
export type LocalLegacyLinkEvidence = { kind: 'manual-edition' } | { kind: 'exact-file'; sha256: string; size: string; bindingFingerprint: string; assetProofFingerprint: string; coverage: LocalLegacyFileCoverage };
/** 关系状态只描述本域边；不会提升旧来源或录音准入。 */
export interface LocalLegacyLink { version: 1; datasetId: string; linkId: string; revision: string; state: 'active' | 'revoked'; endpoints: LocalLegacyLinkEndpoints; evidence: LocalLegacyLinkEvidence; lastTransitionEventId: string }
export interface LocalLegacyPreviewGuard { slot: LocalLegacySlotGuard; expectedLinkRevision: string | null; endpointsFingerprint: string | null; editionMembersFingerprint: string | null; bindingFingerprint: string | null; assetProofFingerprint: string | null }
export interface LocalLegacyPreviewBody { version: 1; datasetId: string; previewId: string; plannedLinkId: string; createdAt: string; expiresAt: string; intent: LocalLegacyLinkIntent; reason: string; before: LocalLegacyLink | null; endpoints: LocalLegacyLinkEndpoints; evidence: LocalLegacyLinkEvidence; guard: LocalLegacyPreviewGuard }
export interface LocalLegacyLinkPreview { previewId: string; revision: '1'; datasetId: string; body: LocalLegacyPreviewBody; previewHash: string; contextFingerprint: string }
export interface LocalLegacyLinkReceipt { datasetId: string; commandId: string; action: 'confirm' | 'revoke' | 'undo'; previewId: string; outcome: 'applied' | 'rejected'; link: LocalLegacyLink | null; transitionEventId: string | null; issue: LocalLegacyLinksIssue | null }
export interface LocalLegacyLinkTransition { eventId: string; datasetId: string; linkId: string; commandId: string; previewId: string; action: 'confirmed' | 'revoked' | 'undone'; occurredAt: string; reason: string; before: LocalLegacyLink | null; after: LocalLegacyLink; undoOfEventId: string | null }
export interface LocalLegacyLinksReadPage { datasetId: string; selectorFingerprint: string; snapshotFingerprint: string; limit: number; items: LocalLegacyLink[]; slot: LocalLegacySlotGuard | null; cursor: string | null; hasMore: boolean }
export interface LocalLegacyLinksHistoryPage { datasetId: string; linkId: string; snapshotFingerprint: string; limit: number; items: LocalLegacyLinkTransition[]; cursor: string | null; hasMore: boolean }
export interface LocalLegacyLinksCommandPayloads { 'localLegacyLinks.read': ReadLocalLegacyLinks; 'localLegacyLinks.history': HistoryLocalLegacyLinks; 'localLegacyLinks.preview': PreviewLocalLegacyLink; 'localLegacyLinks.confirm': ExecuteLocalLegacyLink; 'localLegacyLinks.revoke': ExecuteLocalLegacyLink; 'localLegacyLinks.undo': ExecuteLocalLegacyLink }
export interface LocalLegacyLinksCommandResults { 'localLegacyLinks.read': LocalLegacyLinksReadPage; 'localLegacyLinks.history': LocalLegacyLinksHistoryPage; 'localLegacyLinks.preview': LocalLegacyLinkPreview; 'localLegacyLinks.confirm': LocalLegacyLinkReceipt; 'localLegacyLinks.revoke': LocalLegacyLinkReceipt; 'localLegacyLinks.undo': LocalLegacyLinkReceipt }
export type LocalLegacyLinksCommand = keyof LocalLegacyLinksCommandPayloads;
export type LocalLegacyLinksExecuteCommand = 'localLegacyLinks.confirm' | 'localLegacyLinks.revoke' | 'localLegacyLinks.undo';
export interface LocalLegacyLinksPublicApi {
  readLocalLegacyLinks(request: ReadLocalLegacyLinks): Promise<LocalLegacyLinksReadPage>;
  historyLocalLegacyLinks(request: HistoryLocalLegacyLinks): Promise<LocalLegacyLinksHistoryPage>;
  previewLocalLegacyLink(request: PreviewLocalLegacyLink): Promise<LocalLegacyLinkPreview>;
  confirmLocalLegacyLink(request: ExecuteLocalLegacyLink): Promise<LocalLegacyLinkReceipt>;
  revokeLocalLegacyLink(request: ExecuteLocalLegacyLink): Promise<LocalLegacyLinkReceipt>;
  undoLocalLegacyLink(request: ExecuteLocalLegacyLink): Promise<LocalLegacyLinkReceipt>;
}

type RecordValue = Record<string, unknown>;
const surrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const utf8Bytes = (v: string): number => new TextEncoder().encode(v).byteLength;
export function localLegacyRecord(v: unknown, required: readonly string[], optional: readonly string[] = []): v is RecordValue {
  try {
  if (v === null || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const keys = Reflect.ownKeys(v); if (keys.length > 32 || !required.every(k => Object.hasOwn(v, k))) return false;
  return keys.every(k => typeof k === 'string' && [...required, ...optional].includes(k) && Object.getOwnPropertyDescriptor(v, k)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
  } catch { return false; }
}
export function localLegacyArray(v: unknown, limit: number): v is unknown[] {
  try {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > limit || Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false; }
  return true;
  } catch { return false; }
}
/** 只观察原始描述符一次，后续使用独立冻结纯数据，不执行普通 Get/getter/toJSON。 */
export function localLegacyLinksDataSnapshot(v: unknown, maxBytes = 65536, maxNodes = 2048, maxArray = 128): unknown {
  let nodes = 0, bytes = 0; const active = new Set<object>();
  const invalid = (): never => { throw new Error('本地关联数据描述符或预算无效。'); };
  const add = (n: number): void => { if ((bytes += n) > maxBytes) invalid(); };
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 12) invalid();
    if (value === null || typeof value === 'boolean') { add(JSON.stringify(value).length); return value; }
    if (typeof value === 'string') { if (surrogate.test(value) || value.length > maxBytes) invalid(); add(utf8Bytes(JSON.stringify(value))); return value; }
    if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid(); add(String(value).length); return value; }
    if (!value || typeof value !== 'object' || active.has(value)) return invalid();
    active.add(value);
    try {
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        if (prototype !== Array.prototype || !length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maxArray || keys.length !== length.value + 1 || !keys.includes('length')) return invalid();
        add(Math.max(0, length.value - 1) + 2); const copy: unknown[] = [];
        for (let i = 0; i < length.value; i++) {
          const d = Object.getOwnPropertyDescriptor(value, String(i));
          if (!keys.includes(String(i)) || !d?.enumerable || !Object.hasOwn(d, 'value')) return invalid();
          copy.push(walk(d.value, depth + 1));
        }
        return Object.freeze(copy);
      } else {
        if (![Object.prototype, null].includes(prototype) || keys.length > 32) return invalid();
        add(Math.max(0, keys.length - 1) + 2); const copy: RecordValue = {};
        for (const key of keys) {
          if (typeof key !== 'string' || surrogate.test(key)) return invalid();
          const d = Object.getOwnPropertyDescriptor(value, key);
          if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid();
          add(utf8Bytes(JSON.stringify(key)) + 1);
          Object.defineProperty(copy, key, { enumerable: true, value: walk(d.value, depth + 1) });
        }
        return Object.freeze(copy);
      }
    } finally { active.delete(value); }
  };
  try { return walk(v, 0); } catch { return invalid(); }
}
export function localLegacyLinksSafeData(v: unknown, maxBytes = 65536, maxNodes = 2048, maxArray = 128): boolean { try { localLegacyLinksDataSnapshot(v, maxBytes, maxNodes, maxArray); return true; } catch { return false; } }
const codePointOrder = (a: string, b: string): number => {
  const aa = Array.from(a, c => c.codePointAt(0)!), bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
};
/** 新域 canonical-v1 独立于全部旧账本 Hash，保留原文字节。 */
export function localLegacyLinksCanonical(v: unknown, maxBytes = 65536, maxNodes = 2048, maxArray = 128): string {
  const snapshot = localLegacyLinksDataSnapshot(v, maxBytes, maxNodes, maxArray);
  const encode = (value: unknown): string => Array.isArray(value) ? `[${value.map(encode).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort(codePointOrder).map(k => `${JSON.stringify(k)}:${encode((value as RecordValue)[k])}`).join(',')}}` : JSON.stringify(value);
  return encode(snapshot);
}
export const localLegacyEqual = (a: unknown, b: unknown): boolean => localLegacyLinksCanonical(a) === localLegacyLinksCanonical(b);
export const isLocalLegacyHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export const isLocalLegacyTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const isLocalLegacyReason = (v: unknown): v is string => typeof v === 'string' && v.length <= 240 && v.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(v) && !surrogate.test(v);
export const isLocalLegacyByteCount = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,10}$/u.test(v) && BigInt(v) <= 68719476736n;
const revisionNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const nullableId = (v: unknown): v is string | null => v === null || isCollectionId(v);
const nullableHash = (v: unknown): v is string | null => v === null || isLocalLegacyHash(v);
const segment = (v: unknown): v is LocalTrackSegment | null => v === null || isLocalTrackSegment(v);
const cursor = (v: unknown): v is string | null => v === null || typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/u.test(v);
const limit = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 100;
const slotGuard = (v: unknown): v is LocalLegacySlotGuard => localLegacyRecord(v, ['activeLinkId', 'lastTransitionEventId']) && nullableId(v.activeLinkId) && nullableId(v.lastTransitionEventId) && (v.activeLinkId === null || v.lastTransitionEventId !== null);
function legacyKey(v: unknown): v is LocalLegacyKey {
  return localLegacyRecord(v, ['kind', 'physicalReleaseId']) && v.kind === 'physical-release' && isCollectionId(v.physicalReleaseId)
    || localLegacyRecord(v, ['kind', 'digitalAlbumId']) && v.kind === 'digital-album' && isCollectionId(v.digitalAlbumId)
    || localLegacyRecord(v, ['kind', 'draftId', 'draftTrackId', 'sourceBindingId']) && v.kind === 'draft-source' && [v.draftId, v.draftTrackId, v.sourceBindingId].every(isCollectionId);
}
function isSelector(v: unknown): v is LocalLegacySelector {
  return localLegacyRecord(v, ['by', 'linkId']) && v.by === 'link' && isCollectionId(v.linkId)
    || localLegacyRecord(v, ['by', 'key']) && (v.by === 'legacy' ? legacyKey(v.key) : v.by === 'local' && (localLegacyRecord(v.key, ['kind', 'localEditionId']) && v.key.kind === 'local-edition' && isCollectionId(v.key.localEditionId)
      || localLegacyRecord(v.key, ['kind', 'localTrackId', 'assetId']) && v.key.kind === 'local-track-asset' && isCollectionId(v.key.localTrackId) && isCollectionId(v.key.assetId)));
}
function isChoice(v: unknown): v is LocalLegacyLinkChoice {
  if (localLegacyRecord(v, ['kind', 'subject', 'localEditionId', 'expectedEditionRevision', 'expectedSlot']) && v.kind === 'legacy-edition') {
    return isCollectionId(v.localEditionId) && isLocalCatalogRevision(v.expectedEditionRevision) && slotGuard(v.expectedSlot)
      && (localLegacyRecord(v.subject, ['kind', 'physicalReleaseId', 'expectedRevision']) && v.subject.kind === 'physical-release' && isCollectionId(v.subject.physicalReleaseId) && revisionNumber(v.subject.expectedRevision)
        || localLegacyRecord(v.subject, ['kind', 'digitalAlbumId', 'expectedRevision']) && v.subject.kind === 'digital-album' && isCollectionId(v.subject.digitalAlbumId) && revisionNumber(v.subject.expectedRevision));
  }
  return localLegacyRecord(v, ['kind', 'draftId', 'draftTrackId', 'expectedDraftRevision', 'sourceBindingId', 'localTrackId', 'assetId', 'expectedSelectionRevision', 'expectedLibraryRootRevision', 'expectedFileRevision', 'expectedLocationRevision', 'expectedSegment', 'expectedSlot']) && v.kind === 'draft-source-track'
    && [v.draftId, v.draftTrackId, v.sourceBindingId, v.localTrackId, v.assetId].every(isCollectionId) && revisionNumber(v.expectedDraftRevision)
    && [v.expectedSelectionRevision, v.expectedLibraryRootRevision, v.expectedFileRevision, v.expectedLocationRevision].every(isLocalCatalogRevision) && segment(v.expectedSegment) && slotGuard(v.expectedSlot);
}
function linkIntent(v: unknown): v is LocalLegacyLinkIntent {
  return localLegacyRecord(v, ['action', 'choice']) && v.action === 'link' && isChoice(v.choice)
    || localLegacyRecord(v, ['action', 'linkId', 'expectedLinkRevision']) && v.action === 'revoke' && isCollectionId(v.linkId) && isLocalCatalogRevision(v.expectedLinkRevision)
    || localLegacyRecord(v, ['action', 'linkId', 'expectedLinkRevision', 'undoTransitionEventId']) && v.action === 'undo' && isCollectionId(v.linkId) && isLocalCatalogRevision(v.expectedLinkRevision) && isCollectionId(v.undoTransitionEventId);
}
function linkEndpoints(v: unknown): v is LocalLegacyLinkEndpoints {
  if (localLegacyRecord(v, ['kind', 'subject', 'localEditionId', 'editionRevision', 'title', 'edition']) && v.kind === 'legacy-edition') {
    if (!isCollectionId(v.localEditionId) || !isLocalCatalogRevision(v.editionRevision) || !isLocalCatalogText(v.title) || !isLocalCatalogText(v.edition, true)) return false;
    const s = v.subject;
    if (localLegacyRecord(s, ['kind', 'digitalAlbumId', 'revision', 'metadata']) && s.kind === 'digital-album') return isCollectionId(s.digitalAlbumId) && revisionNumber(s.revision) && isDigitalAlbumMetadata(s.metadata);
    return localLegacyRecord(s, ['kind', 'physicalReleaseId', 'revision', 'summary', 'releaseFingerprint']) && s.kind === 'physical-release' && isCollectionId(s.physicalReleaseId) && revisionNumber(s.revision) && isLocalLegacyHash(s.releaseFingerprint)
      && localLegacyRecord(s.summary, ['format', 'title', 'artist', 'year', 'edition']) && (s.summary.format === 'cd' || s.summary.format === 'cassette') && isLocalLegacyReason(s.summary.title) && typeof s.summary.artist === 'string' && s.summary.artist.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(s.summary.artist)
      && (s.summary.year === null || typeof s.summary.year === 'number' && Number.isSafeInteger(s.summary.year) && s.summary.year >= 1900 && s.summary.year <= 2200) && (s.summary.edition === null || typeof s.summary.edition === 'string' && s.summary.edition.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(s.summary.edition));
  }
  return localLegacyRecord(v, ['kind', 'draftId', 'draftTrackId', 'draftRevision', 'sourceBindingId', 'bindingRootId', 'localTrackId', 'assetId', 'selectionRevision', 'libraryRootId', 'sourceRootId', 'libraryRootRevision', 'assetRootRevision', 'fileRevision', 'locationRevision', 'segment']) && v.kind === 'draft-source-track'
    && [v.draftId, v.draftTrackId, v.sourceBindingId, v.bindingRootId, v.localTrackId, v.assetId, v.libraryRootId, v.sourceRootId].every(isCollectionId) && revisionNumber(v.draftRevision)
    && [v.selectionRevision, v.libraryRootRevision, v.assetRootRevision, v.fileRevision, v.locationRevision].every(isLocalCatalogRevision) && segment(v.segment);
}
function isEvidence(v: unknown, endpoints: LocalLegacyLinkEndpoints): v is LocalLegacyLinkEvidence {
  if (endpoints.kind === 'legacy-edition') return localLegacyRecord(v, ['kind']) && v.kind === 'manual-edition';
  if (!localLegacyRecord(v, ['kind', 'sha256', 'size', 'bindingFingerprint', 'assetProofFingerprint', 'coverage']) || v.kind !== 'exact-file' || ![v.sha256, v.bindingFingerprint, v.assetProofFingerprint].every(isLocalLegacyHash) || !isLocalLegacyByteCount(v.size)) return false;
  return localLegacyRecord(v.coverage, ['mode']) && v.coverage.mode === 'whole-file' && endpoints.segment === null
    || localLegacyRecord(v.coverage, ['mode', 'segment', 'sourceFrames', 'sourceTimebaseHz']) && v.coverage.mode === 'whole-file-span' && isLocalTrackSegment(v.coverage.segment) && localLegacyEqual(v.coverage.segment, endpoints.segment)
      && v.coverage.segment.startFrame === '0' && v.coverage.segment.endFrameExclusive === v.coverage.sourceFrames && v.coverage.segment.timebaseHz === v.coverage.sourceTimebaseHz;
}
function edge(v: unknown): v is LocalLegacyLink {
  return localLegacyRecord(v, ['version', 'datasetId', 'linkId', 'revision', 'state', 'endpoints', 'evidence', 'lastTransitionEventId']) && v.version === 1 && [v.datasetId, v.linkId, v.lastTransitionEventId].every(isCollectionId) && isLocalCatalogRevision(v.revision) && (v.state === 'active' || v.state === 'revoked') && linkEndpoints(v.endpoints) && isEvidence(v.evidence, v.endpoints) && utf8Bytes(localLegacyLinksCanonical(v)) <= LOCAL_LEGACY_LINKS_BUDGET.edgeBytes;
}
export function isLocalLegacyLink(v: unknown): v is LocalLegacyLink { try { return edge(localLegacyLinksDataSnapshot(v)); } catch { return false; } }
function preview(v: unknown): v is LocalLegacyLinkPreview {
  if (!localLegacyRecord(v, ['previewId', 'revision', 'datasetId', 'body', 'previewHash', 'contextFingerprint']) || !isCollectionId(v.previewId) || !isCollectionId(v.datasetId) || v.revision !== '1' || ![v.previewHash, v.contextFingerprint].every(isLocalLegacyHash)) return false;
  const b = v.body;
  if (!localLegacyRecord(b, ['version', 'datasetId', 'previewId', 'plannedLinkId', 'createdAt', 'expiresAt', 'intent', 'reason', 'before', 'endpoints', 'evidence', 'guard']) || b.version !== 1 || b.datasetId !== v.datasetId || b.previewId !== v.previewId || !isCollectionId(b.plannedLinkId) || !isLocalLegacyTime(b.createdAt) || !isLocalLegacyTime(b.expiresAt) || Date.parse(b.expiresAt) <= Date.parse(b.createdAt) || Date.parse(b.expiresAt) - Date.parse(b.createdAt) > 600000
    || !linkIntent(b.intent) || !isLocalLegacyReason(b.reason) || !(b.before === null || edge(b.before)) || !linkEndpoints(b.endpoints) || !isEvidence(b.evidence, b.endpoints)
    || !localLegacyRecord(b.guard, ['slot', 'expectedLinkRevision', 'endpointsFingerprint', 'editionMembersFingerprint', 'bindingFingerprint', 'assetProofFingerprint']) || !slotGuard(b.guard.slot) || !(b.guard.expectedLinkRevision === null || isLocalCatalogRevision(b.guard.expectedLinkRevision)) || ![b.guard.endpointsFingerprint, b.guard.editionMembersFingerprint, b.guard.bindingFingerprint, b.guard.assetProofFingerprint].every(nullableHash)) return false;
  const g = b.guard as unknown as LocalLegacyPreviewGuard, intent = b.intent;
  if (intent.action === 'link') {
    if (b.before !== null || g.expectedLinkRevision !== null || !localLegacyEqual(g.slot, intent.choice.expectedSlot) || g.slot.activeLinkId !== null || !choiceMatches(intent.choice, b.endpoints)) return false;
  } else {
    if (b.before === null || b.before.datasetId !== v.datasetId || b.plannedLinkId !== b.before.linkId || intent.linkId !== b.before.linkId || intent.expectedLinkRevision !== b.before.revision || g.expectedLinkRevision !== b.before.revision || !localLegacyEqual(b.endpoints, b.before.endpoints) || !localLegacyEqual(b.evidence, b.before.evidence)) return false;
    if (g.slot.activeLinkId !== (b.before.state === 'active' ? b.before.linkId : null) || g.slot.lastTransitionEventId !== b.before.lastTransitionEventId) return false;
    if (intent.action === 'revoke' ? b.before.state !== 'active' : intent.undoTransitionEventId !== b.before.lastTransitionEventId) return false;
  }
  const restores = intent.action === 'link' || intent.action === 'undo' && b.before?.state === 'revoked';
  return (restores ? g.endpointsFingerprint !== null && (b.evidence.kind === 'manual-edition' ? g.editionMembersFingerprint !== null && g.bindingFingerprint === null && g.assetProofFingerprint === null : g.editionMembersFingerprint === null && g.bindingFingerprint === b.evidence.bindingFingerprint && g.assetProofFingerprint === b.evidence.assetProofFingerprint)
    : [g.endpointsFingerprint, g.editionMembersFingerprint, g.bindingFingerprint, g.assetProofFingerprint].every(x => x === null)) && utf8Bytes(localLegacyLinksCanonical(v)) <= LOCAL_LEGACY_LINKS_BUDGET.previewBytes;
}
function choiceMatches(c: LocalLegacyLinkChoice, e: LocalLegacyLinkEndpoints): boolean {
  if (c.kind === 'legacy-edition' && e.kind === 'legacy-edition') return c.localEditionId === e.localEditionId && c.expectedEditionRevision === e.editionRevision && c.subject.kind === e.subject.kind && c.subject.expectedRevision === e.subject.revision && (c.subject.kind === 'physical-release' ? e.subject.kind === 'physical-release' && c.subject.physicalReleaseId === e.subject.physicalReleaseId : e.subject.kind === 'digital-album' && c.subject.digitalAlbumId === e.subject.digitalAlbumId);
  return c.kind === 'draft-source-track' && e.kind === 'draft-source-track' && c.draftId === e.draftId && c.draftTrackId === e.draftTrackId && c.expectedDraftRevision === e.draftRevision && c.sourceBindingId === e.sourceBindingId && c.localTrackId === e.localTrackId && c.assetId === e.assetId && c.expectedSelectionRevision === e.selectionRevision && c.expectedLibraryRootRevision === e.libraryRootRevision && c.expectedFileRevision === e.fileRevision && c.expectedLocationRevision === e.locationRevision && localLegacyEqual(c.expectedSegment, e.segment);
}
export function isLocalLegacyLinkPreview(v: unknown): v is LocalLegacyLinkPreview { try { return preview(localLegacyLinksDataSnapshot(v)); } catch { return false; } }
function receipt(v: unknown): v is LocalLegacyLinkReceipt {
  return localLegacyRecord(v, ['datasetId', 'commandId', 'action', 'previewId', 'outcome', 'link', 'transitionEventId', 'issue']) && [v.datasetId, v.commandId, v.previewId].every(isCollectionId) && (v.action === 'confirm' || v.action === 'revoke' || v.action === 'undo') && (v.outcome === 'applied'
    ? edge(v.link) && v.link.datasetId === v.datasetId && isCollectionId(v.transitionEventId) && v.link.lastTransitionEventId === v.transitionEventId && v.issue === null && (v.action === 'confirm' ? v.link.state === 'active' && v.link.revision === '1' : v.action === 'revoke' ? v.link.state === 'revoked' && BigInt(v.link.revision) > 1n : BigInt(v.link.revision) > 1n)
    : v.outcome === 'rejected' && v.link === null && v.transitionEventId === null && typeof v.issue === 'string' && (LOCAL_LEGACY_LINKS_ISSUES as readonly string[]).includes(v.issue));
}
export function isLocalLegacyLinkReceipt(v: unknown): v is LocalLegacyLinkReceipt { try { return receipt(localLegacyLinksDataSnapshot(v)); } catch { return false; } }
function transition(v: unknown): v is LocalLegacyLinkTransition {
  if (!localLegacyRecord(v, ['eventId', 'datasetId', 'linkId', 'commandId', 'previewId', 'action', 'occurredAt', 'reason', 'before', 'after', 'undoOfEventId']) || ![v.eventId, v.datasetId, v.linkId, v.commandId, v.previewId].every(isCollectionId) || !isLocalLegacyTime(v.occurredAt) || !isLocalLegacyReason(v.reason) || !edge(v.after) || v.after.datasetId !== v.datasetId || v.after.linkId !== v.linkId || v.after.lastTransitionEventId !== v.eventId) return false;
  if (v.action === 'confirmed') return v.before === null && v.undoOfEventId === null && v.after.revision === '1' && v.after.state === 'active';
  if (!edge(v.before) || v.before.datasetId !== v.datasetId || v.before.linkId !== v.linkId || BigInt(v.after.revision) !== BigInt(v.before.revision) + 1n || !localLegacyEqual(v.before.endpoints, v.after.endpoints) || !localLegacyEqual(v.before.evidence, v.after.evidence)) return false;
  return v.action === 'revoked' ? v.undoOfEventId === null && v.before.state === 'active' && v.after.state === 'revoked' : v.action === 'undone' && isCollectionId(v.undoOfEventId) && v.undoOfEventId === v.before.lastTransitionEventId && v.before.state !== v.after.state;
}
export function isLocalLegacyLinkTransition(v: unknown): v is LocalLegacyLinkTransition { try { return transition(localLegacyLinksDataSnapshot(v)); } catch { return false; } }
export const isLocalLegacyLinksCommand = (v: unknown): v is LocalLegacyLinksCommand => typeof v === 'string' && (LOCAL_LEGACY_LINKS_COMMANDS as readonly string[]).includes(v);
export function isLocalLegacyLinksCommandPayload<C extends LocalLegacyLinksCommand>(command: C, v: unknown): v is LocalLegacyLinksCommandPayloads[C] {
  try {
    v = localLegacyLinksDataSnapshot(v, LOCAL_LEGACY_LINKS_BUDGET.requestBytes, 2048, 100);
    switch (command) {
      case 'localLegacyLinks.read': return localLegacyRecord(v, ['datasetId', 'selector', 'state', 'cursor', 'limit']) && isCollectionId(v.datasetId) && isSelector(v.selector) && (v.state === 'active' || v.state === 'all') && cursor(v.cursor) && limit(v.limit);
      case 'localLegacyLinks.history': return localLegacyRecord(v, ['datasetId', 'linkId', 'cursor', 'limit']) && isCollectionId(v.datasetId) && isCollectionId(v.linkId) && cursor(v.cursor) && limit(v.limit);
      case 'localLegacyLinks.preview': return localLegacyRecord(v, ['datasetId', 'commandId', 'intent', 'reason']) && [v.datasetId, v.commandId].every(isCollectionId) && linkIntent(v.intent) && isLocalLegacyReason(v.reason);
      case 'localLegacyLinks.confirm': case 'localLegacyLinks.revoke': case 'localLegacyLinks.undo': return localLegacyRecord(v, ['datasetId', 'commandId', 'previewId', 'expectedPreviewRevision', 'previewHash', 'contextFingerprint', 'userConfirmed']) && [v.datasetId, v.commandId, v.previewId].every(isCollectionId) && isLocalCatalogRevision(v.expectedPreviewRevision) && [v.previewHash, v.contextFingerprint].every(isLocalLegacyHash) && v.userConfirmed === true;
    }
  } catch { return false; }
}
export function isLocalLegacyLinksCommandResult<C extends LocalLegacyLinksCommand>(command: C, v: unknown): v is LocalLegacyLinksCommandResults[C] {
  try {
    v = localLegacyLinksDataSnapshot(v, LOCAL_LEGACY_LINKS_BUDGET.publicPageBytes, 32768, 100);
    if (command === 'localLegacyLinks.preview') return preview(v);
    if (command !== 'localLegacyLinks.read' && command !== 'localLegacyLinks.history') return receipt(v) && v.action === command.slice('localLegacyLinks.'.length);
    const read = command === 'localLegacyLinks.read';
    if (!localLegacyRecord(v, read ? ['datasetId', 'selectorFingerprint', 'snapshotFingerprint', 'limit', 'items', 'slot', 'cursor', 'hasMore'] : ['datasetId', 'linkId', 'snapshotFingerprint', 'limit', 'items', 'cursor', 'hasMore']) || !isCollectionId(v.datasetId) || !isLocalLegacyHash(v.snapshotFingerprint) || !limit(v.limit) || !localLegacyArray(v.items, v.limit) || typeof v.hasMore !== 'boolean' || !cursor(v.cursor) || (v.hasMore ? v.cursor === null : v.cursor !== null)) return false;
    const page = v;
    return read ? isLocalLegacyHash(page.selectorFingerprint) && (page.slot === null || slotGuard(page.slot)) && (page.items as unknown[]).every(x => edge(x) && x.datasetId === page.datasetId) : isCollectionId(page.linkId) && (page.items as unknown[]).every(x => transition(x) && x.datasetId === page.datasetId && x.linkId === page.linkId);
  } catch { return false; }
}

export function isLocalLegacySlotGuard(v: unknown): v is LocalLegacySlotGuard { try { return slotGuard(localLegacyLinksDataSnapshot(v)); } catch { return false; } }

export function isLocalLegacyKey(v: unknown): v is LocalLegacyKey { try { return legacyKey(localLegacyLinksDataSnapshot(v)); } catch { return false; } }

export function isLocalLegacyLinkIntent(v: unknown): v is LocalLegacyLinkIntent { try { return linkIntent(localLegacyLinksDataSnapshot(v)); } catch { return false; } }

export function isLocalLegacyLinkEndpoints(v: unknown): v is LocalLegacyLinkEndpoints { try { return linkEndpoints(localLegacyLinksDataSnapshot(v)); } catch { return false; } }
