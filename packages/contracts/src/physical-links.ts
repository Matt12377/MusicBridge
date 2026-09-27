import { isCollectionId } from './collection.js';
import type { MusicEntry } from './physical-music.js';
import type { Page, PageRequest } from './library.js';
import type { RoonLibraryPage } from './roon.js';

/** 仅是用户确认的目录元数据，不代表文件、音频 Hash 或 Source Lock。 */
export interface DigitalAlbumMetadata { title: string; artist?: string; year?: number; version?: string }
export interface DigitalAlbum { id: string; metadata: DigitalAlbumMetadata; revision: number; physicalAbsenceConfirmed: boolean }
export type PhysicalRelation = 'exact' | 'probable' | 'related';
export interface PhysicalDigitalLink { id: string; releaseId: string; digitalId: string; relation: PhysicalRelation; ripFromCdConfirmed: boolean; revision: number }
/** 旧账本没有请求原文，只能表示历史未知；新事件保留确认前后与当时的目录证据。 */
export interface PhysicalLinkHistoryEvent {
  id: string; releaseId: string; kind: 'historical-unknown' | 'confirmed' | 'corrected' | 'revoked'; occurredAt: string | null;
  digitalId?: string; linkId?: string; before?: PhysicalDigitalLink; after?: PhysicalDigitalLink;
  evidence?: { source: 'roon-candidate' | 'existing-digital' | 'explicit-removal'; metadata: DigitalAlbumMetadata; reason: string | null; userConfirmed: true | null; legacyRequest: boolean };
}
export interface PhysicalLinksSnapshot { releaseId: string; revision: number; digitalAbsenceConfirmed: boolean; links: readonly { link: PhysicalDigitalLink; album: DigitalAlbum }[] }
export interface DigitalAlbumDetail { album: DigitalAlbum; links: readonly { link: PhysicalDigitalLink; release: MusicEntry }[] }
export interface DigitalRuntime { status: 'available' | 'needs-resolution' | 'unavailable'; reference?: string }
export interface ConfirmPhysicalLinkRequest {
  commandId: string; releaseId: string; expectedRevision: number; relation: PhysicalRelation; ripFromCdConfirmed: boolean; userConfirmed: true;
  reason: string; reference?: string; digitalId?: string;
}
/** v1 持久 Outbox 原文合同：不可改写、补理由或换命令身份。仅用于原命令重放。 */
export interface LegacyConfirmPhysicalLinkRequest { commandId: string; releaseId: string; expectedRevision: number; relation: PhysicalRelation; ripFromCdConfirmed: boolean; userConfirmed: true; reference?: string; digitalId?: string }
export interface RelocateDigitalRequest { commandId: string; digitalId: string; expectedRevision: number; reference: string; userConfirmed: true }
export interface RegisterDigitalRequest { commandId: string; reference: string; physicalAbsenceConfirmed: boolean; userConfirmed: true }
export interface RemovePhysicalLinkRequest { commandId: string; linkId: string; expectedRevision: number; reason: string; userConfirmed: true }
export interface LegacyRemovePhysicalLinkRequest { commandId: string; linkId: string; expectedRevision: number }
export interface ConfirmAbsenceRequest { commandId: string; id: string; target: 'digital' | 'physical'; expectedRevision: number; confirmedAbsent: boolean; userConfirmed: true }
export interface PhysicalLinkResult { id: string; digitalId?: string; linkId?: string }
export interface CollectionMatrixRow {
  id: string; title: string; artist?: string; digitalId?: string; releaseId?: string;
  cd: number; cassette: number; uncertainRelations: number;
  digitalState: 'linked' | 'confirmed-missing' | 'unchecked'; physicalState: 'owned' | 'confirmed-missing' | 'unchecked';
}
export interface PhysicalLinksPublicApi {
  searchPhysicalRoonAlbums(query: string, page: PageRequest): Promise<RoonLibraryPage>;
  listDigitalAlbums(page: PageRequest): Promise<Page<DigitalAlbum>>;
  getDigitalAlbum(id: string): Promise<DigitalAlbumDetail>;
  getPhysicalLinks(releaseId: string): Promise<PhysicalLinksSnapshot>;
  getPhysicalLinkHistory(releaseId: string, page: PageRequest): Promise<Page<PhysicalLinkHistoryEvent>>;
  getDigitalRuntime(id: string): Promise<DigitalRuntime>;
  confirmPhysicalLink(request: ConfirmPhysicalLinkRequest): Promise<PhysicalLinkResult>;
  relocateDigitalAlbum(request: RelocateDigitalRequest): Promise<PhysicalLinkResult>;
  registerDigitalAlbum(request: RegisterDigitalRequest): Promise<PhysicalLinkResult>;
  removePhysicalLink(request: RemovePhysicalLinkRequest): Promise<PhysicalLinkResult>;
  confirmPhysicalAbsence(request: ConfirmAbsenceRequest): Promise<PhysicalLinkResult>;
  getCollectionMatrix(page: PageRequest, query?: string): Promise<Page<CollectionMatrixRow>>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, empty = false): v is string => typeof v === 'string' && v.length <= 240 && (empty || v.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(v);
const integer = (v: unknown, min = 1, max = 1_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const isRoonAlbumReference = (v: unknown): v is string => typeof v === 'string' && /^musicbridge-v2-entity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(v);
export const isAlbumQuery = (v: unknown): v is string => text(v, true);
export function isDigitalAlbumMetadata(v: unknown): v is DigitalAlbumMetadata { return record(v) && keys(v, ['title', 'artist', 'year', 'version']) && text(v.title) && (v.artist === undefined || text(v.artist, true)) && (v.version === undefined || text(v.version, true)) && (v.year === undefined || integer(v.year, 1900, 2200)); }
export function isDigitalAlbum(v: unknown): v is DigitalAlbum { return record(v) && keys(v, ['id', 'metadata', 'revision', 'physicalAbsenceConfirmed']) && isCollectionId(v.id) && isDigitalAlbumMetadata(v.metadata) && integer(v.revision) && typeof v.physicalAbsenceConfirmed === 'boolean'; }
export function isPhysicalDigitalLink(v: unknown): v is PhysicalDigitalLink { return record(v) && keys(v, ['id', 'releaseId', 'digitalId', 'relation', 'ripFromCdConfirmed', 'revision']) && isCollectionId(v.id) && isCollectionId(v.releaseId) && isCollectionId(v.digitalId) && ['exact', 'probable', 'related'].includes(String(v.relation)) && typeof v.ripFromCdConfirmed === 'boolean' && (!v.ripFromCdConfirmed || v.relation === 'exact') && integer(v.revision); }
export function isPhysicalLinkHistoryEvent(v: unknown): v is PhysicalLinkHistoryEvent {
  if (!record(v) || !keys(v, ['id', 'releaseId', 'kind', 'occurredAt', 'digitalId', 'linkId', 'before', 'after', 'evidence']) || !isCollectionId(v.id) || !isCollectionId(v.releaseId)) return false;
  if (v.kind === 'historical-unknown') return v.occurredAt === null && v.digitalId === undefined && v.linkId === undefined && v.before === undefined && v.after === undefined && v.evidence === undefined;
  if (!['confirmed', 'corrected', 'revoked'].includes(String(v.kind)) || typeof v.occurredAt !== 'string' || Number.isNaN(Date.parse(v.occurredAt)) || !isCollectionId(v.digitalId) || !isCollectionId(v.linkId)
    || !record(v.evidence) || !keys(v.evidence, ['source', 'metadata', 'reason', 'userConfirmed', 'legacyRequest']) || !['roon-candidate', 'existing-digital', 'explicit-removal'].includes(String(v.evidence.source))
    || !isDigitalAlbumMetadata(v.evidence.metadata) || typeof v.evidence.legacyRequest !== 'boolean'
    || (v.evidence.legacyRequest ? v.evidence.reason !== null || v.evidence.userConfirmed !== (v.evidence.source === 'explicit-removal' ? null : true) : !text(v.evidence.reason) || v.evidence.userConfirmed !== true)) return false;
  const before = v.before === undefined || isPhysicalDigitalLink(v.before) && v.before.releaseId === v.releaseId && v.before.digitalId === v.digitalId && v.before.id === v.linkId;
  const after = v.after === undefined || isPhysicalDigitalLink(v.after) && v.after.releaseId === v.releaseId && v.after.digitalId === v.digitalId && v.after.id === v.linkId;
  return before && after && (v.kind === 'confirmed' ? v.before === undefined && v.after !== undefined : v.kind === 'corrected' ? v.before !== undefined && v.after !== undefined : v.before !== undefined && v.after === undefined);
}
export function isConfirmPhysicalLinkRequest(v: unknown): v is ConfirmPhysicalLinkRequest {
  return record(v) && keys(v, ['commandId', 'releaseId', 'expectedRevision', 'relation', 'ripFromCdConfirmed', 'userConfirmed', 'reason', 'reference', 'digitalId']) && isCollectionId(v.commandId) && isCollectionId(v.releaseId) && integer(v.expectedRevision)
    && ['exact', 'probable', 'related'].includes(String(v.relation)) && typeof v.ripFromCdConfirmed === 'boolean' && (!v.ripFromCdConfirmed || v.relation === 'exact') && v.userConfirmed === true
    && text(v.reason)
    && (v.reference === undefined ? isCollectionId(v.digitalId) : isRoonAlbumReference(v.reference) && v.digitalId === undefined);
}
export function isLegacyConfirmPhysicalLinkRequest(v: unknown): v is LegacyConfirmPhysicalLinkRequest {
  return record(v) && keys(v, ['commandId', 'releaseId', 'expectedRevision', 'relation', 'ripFromCdConfirmed', 'userConfirmed', 'reference', 'digitalId']) && isCollectionId(v.commandId) && isCollectionId(v.releaseId) && integer(v.expectedRevision)
    && ['exact', 'probable', 'related'].includes(String(v.relation)) && typeof v.ripFromCdConfirmed === 'boolean' && (!v.ripFromCdConfirmed || v.relation === 'exact') && v.userConfirmed === true
    && (v.reference === undefined ? isCollectionId(v.digitalId) : isRoonAlbumReference(v.reference) && v.digitalId === undefined);
}
export function isRelocateDigitalRequest(v: unknown): v is RelocateDigitalRequest { return record(v) && keys(v, ['commandId', 'digitalId', 'expectedRevision', 'reference', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.digitalId) && integer(v.expectedRevision) && isRoonAlbumReference(v.reference) && v.userConfirmed === true; }
export function isRegisterDigitalRequest(v: unknown): v is RegisterDigitalRequest { return record(v) && keys(v, ['commandId', 'reference', 'physicalAbsenceConfirmed', 'userConfirmed']) && isCollectionId(v.commandId) && isRoonAlbumReference(v.reference) && typeof v.physicalAbsenceConfirmed === 'boolean' && v.userConfirmed === true; }
export function isRemovePhysicalLinkRequest(v: unknown): v is RemovePhysicalLinkRequest { return record(v) && keys(v, ['commandId', 'linkId', 'expectedRevision', 'reason', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.linkId) && integer(v.expectedRevision) && text(v.reason) && v.userConfirmed === true; }
export function isLegacyRemovePhysicalLinkRequest(v: unknown): v is LegacyRemovePhysicalLinkRequest { return record(v) && keys(v, ['commandId', 'linkId', 'expectedRevision']) && isCollectionId(v.commandId) && isCollectionId(v.linkId) && integer(v.expectedRevision); }
export function isConfirmAbsenceRequest(v: unknown): v is ConfirmAbsenceRequest { return record(v) && keys(v, ['commandId', 'id', 'target', 'expectedRevision', 'confirmedAbsent', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.id) && ['digital', 'physical'].includes(String(v.target)) && integer(v.expectedRevision) && typeof v.confirmedAbsent === 'boolean' && v.userConfirmed === true; }
export function isPhysicalLinkResult(v: unknown): v is PhysicalLinkResult { return record(v) && keys(v, ['id', 'digitalId', 'linkId']) && isCollectionId(v.id) && (v.digitalId === undefined || isCollectionId(v.digitalId)) && (v.linkId === undefined || isCollectionId(v.linkId)); }
export function isDigitalRuntime(v: unknown): v is DigitalRuntime { return record(v) && keys(v, ['status', 'reference']) && (v.status === 'available' ? isRoonAlbumReference(v.reference) : ['needs-resolution', 'unavailable'].includes(String(v.status)) && v.reference === undefined); }
export function isPhysicalLinksSnapshot(v: unknown): v is PhysicalLinksSnapshot {
  return record(v) && keys(v, ['releaseId', 'revision', 'digitalAbsenceConfirmed', 'links']) && isCollectionId(v.releaseId) && integer(v.revision) && typeof v.digitalAbsenceConfirmed === 'boolean' && Array.isArray(v.links) && v.links.length <= 20
    && (!v.digitalAbsenceConfirmed || v.links.length === 0) && v.links.every(item => record(item) && keys(item, ['link', 'album']) && isPhysicalDigitalLink(item.link) && item.link.releaseId === v.releaseId && isDigitalAlbum(item.album) && item.link.digitalId === item.album.id && !item.album.physicalAbsenceConfirmed);
}
export function isDigitalAlbumDetail(v: unknown, isMusicEntry: (v: unknown) => v is MusicEntry): v is DigitalAlbumDetail {
  return record(v) && keys(v, ['album', 'links']) && isDigitalAlbum(v.album) && Array.isArray(v.links) && v.links.length <= 100 && (!v.album.physicalAbsenceConfirmed || v.links.length === 0)
    && v.links.every(item => record(item) && keys(item, ['link', 'release']) && isPhysicalDigitalLink(item.link) && item.link.digitalId === (v.album as DigitalAlbum).id && isMusicEntry(item.release) && item.release.contentStatus === 'commercial' && item.release.id === item.link.releaseId && (!item.link.ripFromCdConfirmed || item.release.kind === 'cd'));
}
export function isCollectionMatrixRow(v: unknown): v is CollectionMatrixRow {
  return record(v) && keys(v, ['id', 'title', 'artist', 'digitalId', 'releaseId', 'cd', 'cassette', 'uncertainRelations', 'digitalState', 'physicalState']) && isCollectionId(v.id) && text(v.title) && (v.artist === undefined || text(v.artist, true))
    && (v.digitalId === undefined ? isCollectionId(v.releaseId) && v.releaseId === v.id : isCollectionId(v.digitalId) && v.digitalId === v.id && v.releaseId === undefined)
    && integer(v.cd, 0) && integer(v.cassette, 0) && integer(v.uncertainRelations, 0, 100) && ['linked', 'confirmed-missing', 'unchecked'].includes(String(v.digitalState)) && ['owned', 'confirmed-missing', 'unchecked'].includes(String(v.physicalState));
}
