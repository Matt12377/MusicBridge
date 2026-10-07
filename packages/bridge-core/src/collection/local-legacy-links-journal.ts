import { createHash } from 'node:crypto';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { StoredBinding } from '../recording/source-store.js';

export const LOCAL_LEGACY_LINKS_OPERATION = 'LOCAL_LEGACY_LINKS_V1';
export const legacyLinksHash = (value: unknown): string => createHash('sha256').update(dto.localLegacyLinksCanonical(value, 65536, 8192, 200), 'utf8').digest('hex');
export const legacyLinksRequestFingerprint = (command: dto.LocalLegacyLinksCommand, payload: unknown): string => legacyLinksHash({ version: 1, domain: 'localLegacyLinks', command, payload });
export class LegacyLinksError extends Error {
  constructor(readonly code: dto.LocalLegacyLinksIssue) { super(`本地旧库关联拒绝：${code}。`); }
}
export const legacyLinksFail = (code: dto.LocalLegacyLinksIssue): never => { throw new LegacyLinksError(code); };
const corrupt = (): never => legacyLinksFail('RECOVERY_REQUIRED');
export interface LegacyLinksLocator {
  sourceRootId: string; relative: string; rootIdentity: { path: string; dev: string; ino: string; permissionMode: string };
  fileIdentity: { signature: string; permissionMode: string }; directoryIds: string[]; authorized: true;
}
export interface LegacyLinksAssetSnapshot { asset: dto.AudioAsset; track: dto.LocalTrack; libraryRoot: dto.LibraryRoot; relative: string; catalogSha256: string | null }
export interface LegacyLinksSourceCapture { bindingSnapshot: StoredBinding; assetSnapshot: LegacyLinksAssetSnapshot; bindingFingerprint: string; assetProofFingerprint: string; bindingLocator: LegacyLinksLocator; assetLocator: LegacyLinksLocator }
export interface LegacyLinksPrivateCapture { version: 1; datasetId: string; previewId: string; previewHash: string; createdAt: string; expiresAt: string; slot: dto.LocalLegacySlotGuard; endpointsFingerprint: string | null; editionMembersFingerprint: string | null; sourceCapture: LegacyLinksSourceCapture | null }
interface Base { version: 1; eventId: string; occurredAt: string; requestFingerprint: string; eventHash: string }
export type LegacyLinksEvent = Base & (
  { kind: 'preview'; command: 'localLegacyLinks.preview'; request: dto.PreviewLocalLegacyLink; preview: dto.LocalLegacyLinkPreview; privateCapture: LegacyLinksPrivateCapture }
  | { kind: 'decision'; command: dto.LocalLegacyLinksExecuteCommand; request: dto.ExecuteLocalLegacyLink; receipt: dto.LocalLegacyLinkReceipt; transition: dto.LocalLegacyLinkTransition | null }
);
export interface LegacyLinksRecordedEvent { ordinal: number; event: LegacyLinksEvent }
export interface LegacyLinksProjection {
  events: LegacyLinksRecordedEvent[]; previews: Map<string, Extract<LegacyLinksEvent, {kind:'preview'}>>; links: Map<string, dto.LocalLegacyLink>;
  history: Map<string, {ordinal:number;transition:dto.LocalLegacyLinkTransition}[]>; slots: Map<string, dto.LocalLegacySlotGuard>;
  ids: Set<string>; consumed: Set<string>; canonicalBytes: number; highWater: number; snapshotFingerprint: string;
}
export interface LegacyLinksView {
  readonly events: readonly LegacyLinksRecordedEvent[]; readonly links: ReadonlyMap<string,dto.LocalLegacyLink>;
  readonly previews: ReadonlyMap<string,Extract<LegacyLinksEvent,{kind:'preview'}>>;
  readonly history: ReadonlyMap<string,readonly {ordinal:number;transition:dto.LocalLegacyLinkTransition}[]>;
  readonly consumed: ReadonlySet<string>; readonly snapshotFingerprint:string;
  slot(datasetId:string,key:dto.LocalLegacyLinkEndpoints|dto.LocalLegacyKey):dto.LocalLegacySlotGuard;
  receipt(commandId:string,fingerprint:string):LegacyLinksEvent|null;
}
export interface LegacyLinksWriteView extends LegacyLinksView { append(event:LegacyLinksEvent):void }
export const emptyLegacyLinksProjection = (): LegacyLinksProjection => ({ events:[],previews:new Map(),links:new Map(),history:new Map(),slots:new Map(),ids:new Set(),consumed:new Set(),canonicalBytes:0,highWater:0,snapshotFingerprint:legacyLinksHash({version:1,domain:'localLegacyLinks',empty:true}) });
export function copyLegacyLinksProjection(p: LegacyLinksProjection): LegacyLinksProjection {
  return {...p,events:[...p.events],previews:new Map(p.previews),links:new Map(p.links),history:new Map(p.history),slots:new Map(p.slots),ids:new Set(p.ids),consumed:new Set(p.consumed)};
}
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,31})$/u.test(v);
const signed = (v: string): boolean => /^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,31})$/u.test(v);
export const legacyLinksRelative = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f\\:]/u.test(v) && !v.startsWith('/') && v.split('/').every(p => p !== '' && p !== '.' && p !== '..');
function signature(v: unknown, bytes?: number): v is string {
  if (typeof v !== 'string' || Buffer.byteLength(v) > 256) return false; const p = v.split(':');
  return p.length === 5 && p.slice(0,3).every(decimal) && p.slice(3).every(signed) && (bytes === undefined || p[2] === String(bytes));
}
export function isLegacyLinksBinding(v: unknown): v is StoredBinding {
  if (!dto.localLegacyRecord(v,['id','rootId','relative','acquisition','evidence','userConfirmed','invalidated']) || ![v.id,v.rootId].every(dto.isCollectionId) || !legacyLinksRelative(v.relative) || !dto.isSourceAcquisition(v.acquisition) || v.userConfirmed !== true || v.invalidated !== false) return false;
  const e = v.evidence;
  return dto.localLegacyRecord(e,['sha256','size','signature','modifiedAt','verifiedAt','technical']) && dto.isLocalLegacyHash(e.sha256) && typeof e.size === 'number' && Number.isSafeInteger(e.size) && e.size >= 1 && e.size <= 68719476736 && signature(e.signature,e.size) && dto.isLocalLegacyTime(e.modifiedAt) && dto.isLocalLegacyTime(e.verifiedAt) && dto.isSourceTechnical(e.technical);
}
function locator(v: unknown): v is LegacyLinksLocator {
  if (!dto.localLegacyRecord(v,['sourceRootId','relative','rootIdentity','fileIdentity','directoryIds','authorized']) || !dto.isCollectionId(v.sourceRootId) || !legacyLinksRelative(v.relative) || v.authorized !== true || !dto.localLegacyArray(v.directoryIds,128) || !v.directoryIds.every(id => typeof id === 'string' && id.split(':').length === 2 && id.split(':').every(decimal))) return false;
  return dto.localLegacyRecord(v.rootIdentity,['path','dev','ino','permissionMode']) && typeof v.rootIdentity.path === 'string' && v.rootIdentity.path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(v.rootIdentity.path) && path.isAbsolute(v.rootIdentity.path) && [v.rootIdentity.dev,v.rootIdentity.ino,v.rootIdentity.permissionMode].every(decimal)
    && dto.localLegacyRecord(v.fileIdentity,['signature','permissionMode']) && signature(v.fileIdentity.signature) && decimal(v.fileIdentity.permissionMode);
}
function sourceCapture(v: unknown, endpoints: dto.LocalLegacyLinkEndpoints, evidence: dto.LocalLegacyLinkEvidence): v is LegacyLinksSourceCapture {
  if (endpoints.kind !== 'draft-source-track' || evidence.kind !== 'exact-file' || !dto.localLegacyRecord(v,['bindingSnapshot','assetSnapshot','bindingFingerprint','assetProofFingerprint','bindingLocator','assetLocator']) || !isLegacyLinksBinding(v.bindingSnapshot) || !locator(v.bindingLocator) || !locator(v.assetLocator)
    || !dto.localLegacyRecord(v.assetSnapshot,['asset','track','libraryRoot','relative','catalogSha256']) || !dto.isAudioAsset(v.assetSnapshot.asset) || !dto.isLocalTrack(v.assetSnapshot.track) || !dto.isLibraryRoot(v.assetSnapshot.libraryRoot) || !legacyLinksRelative(v.assetSnapshot.relative) || !(v.assetSnapshot.catalogSha256 === null || dto.isLocalLegacyHash(v.assetSnapshot.catalogSha256))) return false;
  const b=v.bindingSnapshot,a=v.assetSnapshot.asset,t=v.assetSnapshot.track,r=v.assetSnapshot.libraryRoot;
  if (b.id !== endpoints.sourceBindingId || b.rootId !== endpoints.bindingRootId || b.relative !== v.bindingLocator.relative || b.rootId !== v.bindingLocator.sourceRootId || b.evidence.signature !== v.bindingLocator.fileIdentity.signature || b.evidence.sha256 !== evidence.sha256 || String(b.evidence.size) !== evidence.size
    || a.id !== endpoints.assetId || t.id !== endpoints.localTrackId || t.assetId !== a.id || a.libraryRootId !== r.id || r.id !== endpoints.libraryRootId || a.sourceRootId !== endpoints.sourceRootId || r.sourceRootId !== a.sourceRootId || r.revision !== endpoints.libraryRootRevision || a.rootRevision !== endpoints.assetRootRevision || a.fileRevision !== endpoints.fileRevision || a.locationRevision !== endpoints.locationRevision || t.selectionRevision !== endpoints.selectionRevision || !dto.localLegacyEqual(t.segment,endpoints.segment)
    || v.assetLocator.sourceRootId !== a.sourceRootId || v.assetLocator.relative !== v.assetSnapshot.relative || !signature(v.assetLocator.fileIdentity.signature,b.evidence.size) || v.assetSnapshot.catalogSha256 !== null && v.assetSnapshot.catalogSha256 !== evidence.sha256) return false;
  if (evidence.coverage.mode === 'whole-file-span' && (b.evidence.technical.frameEvidence !== 'container-declared' || String(b.evidence.technical.sampleFrames) !== evidence.coverage.sourceFrames || b.evidence.technical.sampleRate !== evidence.coverage.sourceTimebaseHz || a.sampleFrames !== evidence.coverage.sourceFrames || a.timebaseHz !== evidence.coverage.sourceTimebaseHz)) return false;
  return v.bindingFingerprint === legacyLinksHash(b) && v.bindingFingerprint === evidence.bindingFingerprint && v.assetProofFingerprint === evidence.assetProofFingerprint
    && v.assetProofFingerprint === legacyLinksHash({assetSnapshot:v.assetSnapshot,assetLocator:v.assetLocator,sha256:evidence.sha256,size:evidence.size,coverage:evidence.coverage});
}
export function isLegacyLinksPrivateCapture(v: unknown, preview: dto.LocalLegacyLinkPreview): v is LegacyLinksPrivateCapture {
  if (!dto.localLegacyLinksSafeData(v,16384) || !dto.localLegacyRecord(v,['version','datasetId','previewId','previewHash','createdAt','expiresAt','slot','endpointsFingerprint','editionMembersFingerprint','sourceCapture'])) return false;
  const b=preview.body,g=b.guard;
  if (v.version !== 1 || v.datasetId !== preview.datasetId || v.previewId !== preview.previewId || v.previewHash !== preview.previewHash || v.createdAt !== b.createdAt || v.expiresAt !== b.expiresAt || !dto.localLegacyEqual(v.slot,g.slot) || v.endpointsFingerprint !== g.endpointsFingerprint || v.editionMembersFingerprint !== g.editionMembersFingerprint) return false;
  const restores=b.intent.action === 'link' || b.intent.action === 'undo' && b.before?.state === 'revoked';
  if (!restores) return v.sourceCapture === null;
  if (b.evidence.kind === 'manual-edition') return v.sourceCapture === null && g.endpointsFingerprint === legacyLinksHash({endpoints:b.endpoints,editionMembersFingerprint:g.editionMembersFingerprint});
  return sourceCapture(v.sourceCapture,b.endpoints,b.evidence) && g.endpointsFingerprint === legacyLinksHash({endpoints:b.endpoints,bindingFingerprint:b.evidence.bindingFingerprint,assetProofFingerprint:b.evidence.assetProofFingerprint});
}
export function legacyLinksEventHash(event: Omit<LegacyLinksEvent,'eventHash'>): string { return legacyLinksHash(event); }
export function isLegacyLinksEvent(v: unknown): v is LegacyLinksEvent {
  try {
    if (!dto.localLegacyLinksSafeData(v) || !dto.localLegacyRecord(v,['version','kind','eventId','command','occurredAt','requestFingerprint','request','eventHash'],['preview','privateCapture','receipt','transition']) || v.version !== 1 || !dto.isCollectionId(v.eventId) || !dto.isLocalLegacyTime(v.occurredAt) || !dto.isLocalLegacyHash(v.requestFingerprint) || !dto.isLocalLegacyHash(v.eventHash)) return false;
    if (v.kind === 'preview') {
      if (!dto.localLegacyRecord(v,['version','kind','eventId','command','occurredAt','requestFingerprint','request','preview','privateCapture','eventHash']) || v.command !== 'localLegacyLinks.preview' || !dto.isLocalLegacyLinksCommandPayload(v.command,v.request) || !dto.isLocalLegacyLinkPreview(v.preview) || v.request.datasetId !== v.preview.datasetId || !dto.localLegacyEqual(v.request.intent,v.preview.body.intent) || v.request.reason !== v.preview.body.reason || v.occurredAt !== v.preview.body.createdAt || !isLegacyLinksPrivateCapture(v.privateCapture,v.preview) || v.preview.previewHash !== legacyLinksHash(v.preview.body) || v.preview.contextFingerprint !== legacyLinksHash(v.privateCapture)) return false;
    } else {
      if (!dto.localLegacyRecord(v,['version','kind','eventId','command','occurredAt','requestFingerprint','request','receipt','transition','eventHash']) || v.kind !== 'decision' || (v.command !== 'localLegacyLinks.confirm' && v.command !== 'localLegacyLinks.revoke' && v.command !== 'localLegacyLinks.undo') || !dto.isLocalLegacyLinksCommandPayload(v.command,v.request) || !dto.isLocalLegacyLinksCommandResult(v.command,v.receipt) || v.receipt.datasetId !== v.request.datasetId || v.receipt.commandId !== v.request.commandId || v.receipt.previewId !== v.request.previewId) return false;
      if (v.receipt.outcome === 'rejected') { if (v.transition !== null) return false; }
      else if (!dto.isLocalLegacyLinkTransition(v.transition) || v.transition.eventId !== v.eventId || v.transition.occurredAt !== v.occurredAt || v.transition.commandId !== v.request.commandId || v.transition.previewId !== v.request.previewId || v.transition.datasetId !== v.request.datasetId || !dto.localLegacyEqual(v.transition.after,v.receipt.link) || v.transition.action !== (v.receipt.action === 'confirm' ? 'confirmed' : v.receipt.action === 'revoke' ? 'revoked' : 'undone')) return false;
    }
    if ((v.request as {commandId:string}).commandId === v.eventId || v.requestFingerprint !== legacyLinksRequestFingerprint(v.command as dto.LocalLegacyLinksCommand,v.request)) return false;
    const {eventHash,...body}=v; return eventHash === legacyLinksHash(body);
  } catch { return false; }
}
export function readLegacyLinksEvent(row: Record<string,unknown>): LegacyLinksEvent {
  if (row.operation !== LOCAL_LEGACY_LINKS_OPERATION || typeof row.request !== 'string' || typeof row.result !== 'string' || Object.values(row).reduce<number>((n,v)=>n+(typeof v==='string'?Buffer.byteLength(v):0),0)>65536) return corrupt();
  try {
    const e:unknown=JSON.parse(row.request),result:unknown=JSON.parse(row.result);
    if (!isLegacyLinksEvent(e) || row.request !== dto.localLegacyLinksCanonical(e) || row.result !== dto.localLegacyLinksCanonical(result) || row.command_id !== e.request.commandId || row.fingerprint !== e.requestFingerprint || row.created_at !== e.occurredAt || !dto.localLegacyEqual(result,e.kind==='preview'?e.preview:e.receipt)) return corrupt();
    return e;
  } catch { return corrupt(); }
}
export function legacyLinksSlotKey(datasetId:string,e:dto.LocalLegacyLinkEndpoints | dto.LocalLegacyKey):string {
  if (e.kind==='legacy-edition') return legacyLinksSlotKey(datasetId,e.subject.kind==='physical-release'?{kind:'physical-release',physicalReleaseId:e.subject.physicalReleaseId}:{kind:'digital-album',digitalAlbumId:e.subject.digitalAlbumId});
  return e.kind==='physical-release'?`${datasetId}/physical/${e.physicalReleaseId}`:e.kind==='digital-album'?`${datasetId}/digital/${e.digitalAlbumId}`:`${datasetId}/draft/${e.draftId}/${e.draftTrackId}`;
}
export const legacyLinksSlot = (p:LegacyLinksProjection,datasetId:string,key:dto.LocalLegacyLinkEndpoints | dto.LocalLegacyKey):dto.LocalLegacySlotGuard => p.slots.get(legacyLinksSlotKey(datasetId,key)) ?? {activeLinkId:null,lastTransitionEventId:null};
/** 冷核仅比较事件发生时的本地目录历史；不能拿今天的可变旧端点替代历史。 */
export function verifyLegacyLinksLocalSnapshot(e:LegacyLinksEvent,latest:ReadonlyMap<string,dto.LocalCatalogResult>,privateAssets:ReadonlyMap<string,{relative:unknown;sha256:unknown}>):void {
  if(e.kind!=='preview'||e.preview.body.guard.endpointsFingerprint===null)return;
  const b=e.preview.body;
  if(b.endpoints.kind==='legacy-edition'){
    const edition=latest.get(`local_catalog_editions:${b.endpoints.localEditionId}`);
    if(!dto.isAlbumEdition(edition)||edition.revision!==b.endpoints.editionRevision||edition.title!==b.endpoints.title||edition.edition!==b.endpoints.edition)return corrupt();
    const members=[...latest.values()].filter((v):v is dto.AlbumEditionTrack=>dto.isAlbumEditionTrack(v)&&v.active&&v.editionId===edition.id).sort((a,b)=>a.sequence-b.sequence||(a.id<b.id?-1:a.id>b.id?1:0));
    if(members.length>200||legacyLinksHash(members)!==b.guard.editionMembersFingerprint)return corrupt();
  }else {
    const source=e.privateCapture.sourceCapture;if(!source)return corrupt();const a=source.assetSnapshot;
    for(const [table,key,value] of [['local_catalog_assets',a.asset.id,a.asset],['local_catalog_tracks',a.track.id,a.track],['local_catalog_roots',a.libraryRoot.id,a.libraryRoot]] as const)if(!dto.localLegacyEqual(latest.get(`${table}:${key}`),value))return corrupt();
    if(!dto.localLegacyEqual(privateAssets.get(a.asset.id),{relative:a.relative,sha256:a.catalogSha256}))return corrupt();
  }
}
function freeze<T>(value:T):T { if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value; }
/** 只重放本域严格事件；原目录 latest 与实体计数不进入本投影。 */
export function projectLegacyLinksEvent(p:LegacyLinksProjection,event:LegacyLinksEvent):void {
  if (!isLegacyLinksEvent(event) || p.ids.has(event.eventId)) return corrupt();
  if (p.events.length+1>dto.LOCAL_LEGACY_LINKS_BUDGET.newDomainRows) return legacyLinksFail('BUDGET_EXCEEDED');
  const bytes=Buffer.byteLength(dto.localLegacyLinksCanonical(event)); if(p.canonicalBytes+bytes>dto.LOCAL_LEGACY_LINKS_BUDGET.projectionCanonicalBytes)return legacyLinksFail('BUDGET_EXCEEDED');
  const e=freeze(structuredClone(event)),ordinal=p.events.length+1;
  p.ids.add(e.eventId);
  if(e.kind==='preview'){
    const b=e.preview.body;if(p.ids.has(b.previewId)||b.previewId===e.eventId||b.previewId===e.request.commandId)return corrupt();p.ids.add(b.previewId);
    if(!dto.localLegacyEqual(b.guard.slot,legacyLinksSlot(p,e.request.datasetId,b.endpoints)))return corrupt();
    if(b.intent.action==='link'){if(p.ids.has(b.plannedLinkId)||b.plannedLinkId===e.request.commandId)return corrupt();p.ids.add(b.plannedLinkId);}
    else {const current=p.links.get(b.plannedLinkId);if(!current||!dto.localLegacyEqual(current,b.before))return corrupt();}
    p.previews.set(e.preview.previewId,e);
  }else if(e.receipt.outcome==='applied'){
    const proposal=p.previews.get(e.request.previewId),t=e.transition!;if(!proposal||p.consumed.has(e.request.previewId))return corrupt();
    const b=proposal.preview.body;
    if(proposal.preview.datasetId!==e.request.datasetId||e.request.expectedPreviewRevision!=='1'||e.request.previewHash!==proposal.preview.previewHash||e.request.contextFingerprint!==proposal.preview.contextFingerprint||Date.parse(e.occurredAt)>=Date.parse(b.expiresAt)||Date.parse(e.occurredAt)<Date.parse(b.createdAt)||e.receipt.action!==(b.intent.action==='link'?'confirm':b.intent.action)||t.linkId!==b.plannedLinkId||t.reason!==b.reason||!dto.localLegacyEqual(t.before,b.before)||!dto.localLegacyEqual(t.after.endpoints,b.endpoints)||!dto.localLegacyEqual(t.after.evidence,b.evidence)||!dto.localLegacyEqual(b.guard.slot,legacyLinksSlot(p,e.request.datasetId,b.endpoints)))return corrupt();
    if(t.before===null){if(p.links.has(t.linkId)||b.intent.action!=='link')return corrupt();}
    else if(!dto.localLegacyEqual(p.links.get(t.linkId),t.before))return corrupt();
    if(t.action==='undone'){
      const history=p.history.get(t.linkId),target=history?.at(-1)?.transition;
      if(!target||target.action==='undone'||target.eventId!==t.undoOfEventId||b.intent.action!=='undo'||b.intent.undoTransitionEventId!==target.eventId||target.after.lastTransitionEventId!==b.guard.slot.lastTransitionEventId||!dto.localLegacyEqual(target.after,t.before))return corrupt();
    }
    if(t.action!=='undone'&&BigInt(t.after.revision)>=18446744073709551615n)return corrupt();
    p.links.set(t.linkId,t.after);p.history.set(t.linkId,[...(p.history.get(t.linkId)??[]),{ordinal,transition:t}]);
    p.slots.set(legacyLinksSlotKey(e.request.datasetId,b.endpoints),{activeLinkId:t.after.state==='active'?t.linkId:null,lastTransitionEventId:t.eventId});p.consumed.add(e.request.previewId);
  }
  p.events.push({ordinal,event:e});p.canonicalBytes+=bytes;p.snapshotFingerprint=legacyLinksHash({previous:p.snapshotFingerprint,eventHash:e.eventHash});
}
