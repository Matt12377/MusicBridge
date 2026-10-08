import { createHash } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import type { RootCapability } from '../recording/source-files.js';
import type { SourceFileAttributes } from './source-writes-publisher.js';
import type { RelocationFileObservation, RelocationReadAccess } from './source-relocation-verify.js';
import type { PreparedRelocationReads, RelocationBoundScanFact, RelocationEndpoint, RelocationScanDelta, RelocationScanMapping } from './source-relocation-scan-port.js';

export const LOCAL_RELOCATION_OPERATION = 'LOCAL_RELOCATION_V1' as const;
export const RELOCATION_LEDGER_ROW_BYTES = 65_536;
export const RELOCATION_PHASE_ROW_BYTES = 16_384;
export class LocalRelocationError extends Error {
  constructor(readonly code: dto.LocalRelocationPlanIssueCode) { super(`位置计划拒绝：${code}。`); }
}
export const relocationFail = (code: dto.LocalRelocationPlanIssueCode): never => { throw new LocalRelocationError(code); };
const corrupt = (): never => relocationFail('RECOVERY_REQUIRED');
const record = dto.localRelocationRecord;
const hash = dto.isLocalRelocationPlanHash;
const id = dto.isCollectionId;
const revision = dto.isLocalCatalogRevision;
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,31})$/u.test(value);
const array = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && value.length <= maximum;
const isolatedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function codePointCompare(a: string, b: string): number {
  let at = 0, bt = 0;
  while (at < a.length && bt < b.length) {
    const av = a.codePointAt(at)!, bv = b.codePointAt(bt)!;
    if (av !== bv) return av < bv ? -1 : 1;
    at += av > 0xffff ? 2 : 1; bt += bv > 0xffff ? 2 : 1;
  }
  return at < a.length ? 1 : bt < b.length ? -1 : 0;
}
/** journal 可承载原Reader技术事实的有限小数；公开请求/body/context仍由各自Contracts严核整数。 */
function journalSnapshot(value: unknown): unknown {
  let nodes = 0, textBytes = 0;
  const active = new Set<object>();
  const text = (value: string): void => {
    if (isolatedSurrogate.test(value)) corrupt();
    textBytes += Buffer.byteLength(value, 'utf8');
    if (textBytes > dto.LOCAL_RELOCATION_PLAN_BUDGET.allTextBytes) relocationFail('OVER_BUDGET');
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > dto.LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes || depth > dto.LOCAL_RELOCATION_PLAN_BUDGET.snapshotDepth) return relocationFail('OVER_BUDGET');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { text(value); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) return corrupt(); return value; }
    if (!value || typeof value !== 'object' || active.has(value)) return corrupt();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return corrupt();
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        if (!length || !Object.hasOwn(length, 'value') || !integer(length.value, 0, dto.LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes)
            || Reflect.ownKeys(value).length !== length.value + 1) return corrupt();
        const result: unknown[] = [];
        for (let index = 0; index < length.value; index++) {
          const item = Object.getOwnPropertyDescriptor(value, String(index));
          if (!item?.enumerable || !Object.hasOwn(item, 'value')) return corrupt();
          result.push(walk(item.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return corrupt();
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return corrupt();
        text(key);
        const entry = Object.getOwnPropertyDescriptor(value, key);
        if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return corrupt();
        Object.defineProperty(result, key, { value: walk(entry.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { active.delete(value); }
  };
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > dto.LOCAL_RELOCATION_PLAN_BUDGET.requestUtf8Bytes) relocationFail('OVER_BUDGET');
  return result;
}
export function relocationCanonical(value: unknown): string {
  const captured = journalSnapshot(value);
  const encode = (value: unknown): string => Array.isArray(value) ? `[${value.map(encode).join(',')}]`
    : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort(codePointCompare).map(key => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`).join(',')}}`
      : JSON.stringify(value);
  return encode(captured);
}
export const relocationHash = (value: unknown): string => createHash('sha256').update(`${LOCAL_RELOCATION_OPERATION}\nJOURNAL\n${relocationCanonical(value)}`, 'utf8').digest('hex');
/** 公开choiceId沿既有UUIDv4形状；完整256位族指纹仍另字段认证，不能拿截短ID代替它。 */
export function relocationRecoveryChoiceId(planId: string, fingerprint: string, action: dto.LocalRelocationPlanRecoveryChoice['action']): string {
  const digest = relocationHash({ domain: dto.LOCAL_RELOCATION_PLAN_DOMAIN, planId, fingerprint, action });
  const variant = ((Number.parseInt(digest[16]!, 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export const relocationRequestFingerprint = <C extends dto.LocalRelocationPlanCommand>(command: C, request: dto.LocalRelocationPlanCommandPayloads[C]): string => createHash('sha256').update(dto.localRelocationRequestFingerprintInput(command, request), 'utf8').digest('hex');
export const relocationPlanHash = (body: dto.LocalRelocationFrozenBody): string => createHash('sha256').update(dto.localRelocationPlanHashInput(dto.localRelocationFrozenBodySnapshot(body)), 'utf8').digest('hex');
export const relocationContextFingerprint = (context: dto.LocalRelocationFrozenContext): string => createHash('sha256').update(dto.localRelocationContextFingerprintInput(dto.localRelocationFrozenContextSnapshot(context)), 'utf8').digest('hex');
const equal = (a: unknown, b: unknown): boolean => relocationCanonical(a) === relocationCanonical(b);

export interface RelocationCatalogSnapshot {
  asset: dto.AudioAsset; libraryRoot: dto.LibraryRoot; relative: string; catalogSha256: string | null; tracks: dto.LocalTrack[];
}
export interface RelocationStoredOperation {
  operation: dto.LocalRelocationFrozenOperation; item: dto.LocalRelocationPlanItem; source: RelocationCatalogSnapshot | null;
}
/** OS根身份原始观察留在私有capture；该数据本身绝不是重新取得Root/FD/写claims的能力。 */
export interface RelocationRootIdentityData {
  version: 1; platform: 'darwin' | 'linux'; kind: 'volume' | 'share'; provider: string;
  identity: string; mountIdentity: string; fileSystem: string; rootPhysical: { dev: string; ino: string }; fingerprint: string;
}
export interface RelocationCapturedResource {
  frozen: dto.LocalRelocationFrozenResource; sourceRoot: RootCapability; targetRoot: RootCapability;
  /** absent只证明旧非null全Hash与候选真FD等值，不冒造消失原路径的inode观察。 */
  sourceAbsent: boolean;
  sourceObservationOrigin: 'CURRENT_SOURCE_FD' | 'CANDIDATE_FD_MATCHING_CATALOG_SHA256' | 'AUTHENTICATED_RECOVERY_MATERIAL_FD';
  sourceObservation: RelocationFileObservation; targetObservation: RelocationFileObservation | null;
  sourceIdentity: RelocationRootIdentityData; targetIdentity: RelocationRootIdentityData;
  attributes: SourceFileAttributes; rewriteMaterial: { path: string; sha256: string; bytes: number } | null;
  /** 私有对账材料观察不是消失原路径的观察；来源必须反向绑定祖先READY全Hash。 */
  recovery?: { originPlanId: string; originResourceId: string; material: { root: RootCapability; relative: string; observation: RelocationFileObservation };
    target: { observation: RelocationFileObservation; aliases: { root: RootCapability; relative: string }[] } | null;
    retainedSource: { root: RootCapability; endpoint: dto.LocalRelocationEndpoint; observation: RelocationFileObservation; identity: RelocationRootIdentityData } | null };
  storage?: { resourceId: string; sourcePrivateRoot: RootCapability; targetPrivateRoot: RootCapability; backup: string; quarantine: string; stage: string };
}
export interface RelocationRecoveryOrigin {
  originPlanId: string; originPlanHash: string; originViewRevision: string; originJournalSequence: string; familyRootPlanId: string;
  action: dto.LocalRelocationPlanRecoveryChoice['action']; recoveryFingerprint: string;
  destination: 'source' | 'target';
  operationMappings: { originOperationId: string; operationId: string }[];
}
export interface RelocationPublisherFact {
  operationId: string; resourceId: string; phase: dto.LocalRelocationPlanPhase;
  sourceObservation: RelocationFileObservation | null; targetObservation: RelocationFileObservation | null;
  stage: string | null; quarantine: string | null; retained: string | null; quiet: boolean;
}
export interface RelocationLocationFact {
  operationId: string; resourceId: string; planHash: string; resourceClosureHash: string;
  beforeAsset: dto.AudioAsset; afterAsset: dto.AudioAsset; tracks: dto.LocalTrack[]; catalogSha256: string | null;
  source: RelocationEndpoint; target: RelocationEndpoint;
  sourceObservation: RelocationFileObservation; targetObservation: RelocationFileObservation;
  scan: RelocationBoundScanFact;
}
export interface RelocationCommitLocationsInput {
  commandId: string; requestFingerprint: string; planId: string; planHash: string; resourceClosureHash: string;
  mappings: readonly RelocationScanMapping[]; reads: PreparedRelocationReads; readAccess: RelocationReadAccess;
  rootRelink: Readonly<{ before: dto.LibraryRoot; after: dto.LibraryRoot }> | null;
  mappingProofs: readonly Readonly<{ resourceId: string; sourceObservation: RelocationFileObservation; targetObservation: RelocationFileObservation }>[];
}
export interface RelocationCommitLocationsResult { assets: dto.AudioAsset[]; scan: RelocationScanDelta; facts: RelocationLocationFact[] }
interface EventBase { version: 1; eventId: string; datasetId: string; planId: string | null; occurredAt: string; eventHash: string }
export type RelocationEvent = EventBase & (
  { kind: 'receipt'; command: dto.LocalRelocationPlanReceiptCommand; request: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanReceiptCommand]; requestFingerprint: string; receipt: dto.LocalRelocationPlanReceipt; header: dto.LocalRelocationPlan | null; ownerEpoch: string }
  | { kind: 'operation'; index: number; value: RelocationStoredOperation }
  | { kind: 'root-mapping'; index: number; value: dto.LocalRelocationRootMapping }
  | { kind: 'resource'; index: number; value: RelocationCapturedResource; resource: dto.LocalRelocationPlanResource }
  | { kind: 'reference-edge'; index: number; value: dto.LocalRelocationReferenceEdge }
  | { kind: 'ready'; header: Omit<dto.LocalRelocationFrozenBody, 'operations' | 'rootMappings' | 'resourceClosure'>; closureComplete: boolean; closureFingerprint: string; context: dto.LocalRelocationFrozenContext; planHash: string; contextFingerprint: string }
  | { kind: 'capability'; command: 'localRelocationPlan.confirm' | 'localRelocationPlan.cleanup'; request: dto.LocalRelocationPlanConfirm | dto.LocalRelocationPlanCleanup; requestFingerprint: string; challenge: dto.LocalRelocationMainChallenge }
  | { kind: 'capability-consumed'; commandId: string; challengeId: string; requestFingerprint: string }
  | { kind: 'state'; state: dto.LocalRelocationPlanState; issues: dto.LocalRelocationPlanIssue[]; cleanup: dto.LocalRelocationPlanCleanupView; recoveryChoices: dto.LocalRelocationPlanRecoveryChoice[] }
  | { kind: 'phase'; fact: RelocationPublisherFact; resource: dto.LocalRelocationPlanResource }
  | { kind: 'location-facts'; fact: RelocationLocationFact }
  | { kind: 'root-facts'; beforeRoot: dto.LibraryRoot; afterRoot: dto.LibraryRoot; planHash: string }
  | { kind: 'recovery-origin'; value: RelocationRecoveryOrigin }
  | { kind: 'recovery-resolved'; resourceId: string; recoveryPlanId: string; recoveryResourceId: string; recoveryPlanHash: string; quiet: true }
  | { kind: 'policy-quiet'; policy: dto.LocalRelocationPlanPolicy }
);
type WithoutHash<T> = T extends unknown ? Omit<T, 'eventHash'> : never;
export function relocationEvent<T extends WithoutHash<RelocationEvent>>(body: T): T & { eventHash: string } {
  const captured = journalSnapshot(body) as T;
  const event: T & { eventHash: string } = { ...captured, eventHash: relocationHash(captured) };
  Object.freeze(event);
  const validation: unknown = event;
  if (!isRelocationEvent(validation)) return corrupt();
  return event;
}
export interface RelocationStoredPlan {
  plan: dto.LocalRelocationPlan; ownerEpoch: string; operations: RelocationStoredOperation[];
  rootMappings: dto.LocalRelocationRootMapping[]; resources: RelocationCapturedResource[]; edges: dto.LocalRelocationReferenceEdge[];
  ready: Extract<RelocationEvent, { kind: 'ready' }> | null; events: RelocationEvent[]; phaseCounts: Map<string, number>;
  recoveryOrigin: RelocationRecoveryOrigin | null; resolvedResources: Set<string>;
}
export interface RelocationProjection {
  events: RelocationEvent[]; plans: Map<string, RelocationStoredPlan>; receipts: Map<string, Extract<RelocationEvent, { kind: 'receipt' }>>;
  policy: Map<string, dto.LocalRelocationPlanPolicy>;
  capabilities: Map<string, { issued: Extract<RelocationEvent, { kind: 'capability' }>; consumed: boolean }>;
  locationFacts: Map<string, { fact: RelocationLocationFact; ledgerOrdinal: number }>;
  latestAssets: Map<string, { asset: dto.AudioAsset; relative: string; catalogSha256: string | null; ledgerOrdinal: number }>;
  latestRoots: Map<string, { root: dto.LibraryRoot; ledgerOrdinal: number }>;
  retainedSources: Map<string, { datasetId: string; planId: string; operationId: string; resourceId: string; source: dto.LocalRelocationEndpoint; observation: RelocationFileObservation; target: dto.LocalRelocationEndpoint; planHash: string; ledgerOrdinal: number }>;
  ids: Set<string>; bytes: number; highWater: number; fingerprint: string;
}
export interface RelocationReadView { readonly projection: RelocationProjection; receipt(commandId: string, fingerprint: string): Extract<RelocationEvent, { kind: 'receipt' }> | null }
export interface RelocationWriteView extends RelocationReadView { append(event: RelocationEvent): void; commitLocations(input: RelocationCommitLocationsInput): RelocationCommitLocationsResult }
export const emptyRelocationProjection = (): RelocationProjection => ({ events: [], plans: new Map(), receipts: new Map(), policy: new Map(), capabilities: new Map(),
  locationFacts: new Map(), latestAssets: new Map(), latestRoots: new Map(), retainedSources: new Map(), ids: new Set(), bytes: 0, highWater: 0,
  fingerprint: relocationHash({ domain: LOCAL_RELOCATION_OPERATION, empty: true }) });
export function copyRelocationProjection(projection: RelocationProjection): RelocationProjection {
  return { ...projection, events: [...projection.events], ids: new Set(projection.ids), receipts: new Map(projection.receipts), policy: new Map(projection.policy),
    capabilities: new Map([...projection.capabilities].map(([key, value]) => [key, { ...value }])), locationFacts: new Map(projection.locationFacts),
    latestAssets: new Map(projection.latestAssets), latestRoots: new Map(projection.latestRoots), retainedSources: new Map(projection.retainedSources),
    plans: new Map([...projection.plans].map(([key, value]) => [key, { ...value, plan: structuredClone(value.plan), operations: structuredClone(value.operations),
      rootMappings: structuredClone(value.rootMappings), resources: structuredClone(value.resources), edges: structuredClone(value.edges), events: [...value.events], phaseCounts: new Map(value.phaseCounts),
      recoveryOrigin: structuredClone(value.recoveryOrigin), resolvedResources: new Set(value.resolvedResources) }])) };
}
export const relocationPolicy = (projection: RelocationProjection, datasetId: string): dto.LocalRelocationPlanPolicy => structuredClone(projection.policy.get(datasetId) ?? dto.LOCAL_RELOCATION_PLAN_DEFAULT_POLICY);
function endpoint(value: unknown): value is RelocationEndpoint {
  return record(value, ['libraryRootId', 'sourceRootId', 'rootRevision', 'relative']) && [value.libraryRootId, value.sourceRootId].every(id)
    && revision(value.rootRevision) && dto.isLocalRelocationRelative(value.relative, false);
}
function observation(value: unknown, alias = false): value is RelocationFileObservation {
  return record(value, ['sha256', 'bytes', 'signature', 'physical', 'birthtimeNs', 'permissionMode', 'uid', 'gid', 'links']) && hash(value.sha256)
    && integer(value.bytes, 0, dto.LOCAL_RELOCATION_PLAN_BUDGET.singleSourceBytes) && typeof value.signature === 'string' && value.signature.length <= 256
    && record(value.physical, ['dev', 'ino']) && [value.physical.dev, value.physical.ino, value.birthtimeNs, value.permissionMode, value.uid, value.gid, value.links].every(decimal)
    && Number(value.permissionMode) <= 4095 && (value.links === '1' || alias && value.links === '2');
}
function root(value: unknown): value is RootCapability {
  return record(value, ['id', 'path', 'dev', 'ino', 'authorized', 'label']) && id(value.id) && dto.isLocalRelocationMainAbsolutePath(value.path)
    && [value.dev, value.ino].every(decimal) && value.authorized === true && typeof value.label === 'string' && value.label.length <= 240;
}
function identity(value: unknown): value is RelocationRootIdentityData {
  if (!record(value, ['version', 'platform', 'kind', 'provider', 'identity', 'mountIdentity', 'fileSystem', 'rootPhysical', 'fingerprint']) || value.version !== 1
    || !['darwin', 'linux'].includes(String(value.platform)) || !['volume', 'share'].includes(String(value.kind))
    || ![value.provider, value.identity, value.mountIdentity, value.fileSystem].every(text => typeof text === 'string' && text.length > 0 && text.length <= 4096)
    || !record(value.rootPhysical, ['dev', 'ino']) || ![value.rootPhysical.dev, value.rootPhysical.ino].every(decimal) || !hash(value.fingerprint)) return false;
  const { fingerprint, ...body } = value; return relocationHash(body) === fingerprint;
}
function attributes(value: unknown): boolean {
  return record(value, ['mode', 'uid', 'gid', 'proof'], ['provenance']) && [value.mode, value.uid, value.gid].every(decimal) && Number(value.mode) <= 4095
    && (['MACOS_EMPTY_XATTR_ACL_FLAGS_V1', 'LINUX_EMPTY_XATTR_ACL_FLAGS_V1'].includes(String(value.proof)) && !Object.hasOwn(value, 'provenance')
      || value.proof === 'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1' && record(value.provenance, ['bytes', 'sha256']) && value.provenance.bytes === 11 && hash(value.provenance.sha256));
}
function catalogSnapshot(value: unknown): value is RelocationCatalogSnapshot {
  if (!record(value, ['asset', 'libraryRoot', 'relative', 'catalogSha256', 'tracks']) || !dto.isAudioAsset(value.asset) || !dto.isLibraryRoot(value.libraryRoot)
    || !dto.isLocalRelocationRelative(value.relative, false) || value.catalogSha256 !== null && !hash(value.catalogSha256)
    || !array(value.tracks, 200) || !value.tracks.length) return false;
  const asset = value.asset, libraryRoot = value.libraryRoot, tracks = value.tracks;
  return asset.libraryRootId === libraryRoot.id && asset.sourceRootId === libraryRoot.sourceRootId && asset.rootRevision === libraryRoot.revision
    && tracks.every(track => dto.isLocalTrack(track) && track.assetId === asset.id)
    && new Set(tracks.map(track => (track as dto.LocalTrack).id)).size === tracks.length;
}
function capturedResource(value: unknown): value is RelocationCapturedResource {
  if (!record(value, ['frozen', 'sourceRoot', 'targetRoot', 'sourceAbsent', 'sourceObservationOrigin', 'sourceObservation', 'targetObservation', 'sourceIdentity', 'targetIdentity', 'attributes', 'rewriteMaterial'], ['recovery', 'storage'])
    || !root(value.sourceRoot) || !root(value.targetRoot) || !observation(value.sourceObservation) || value.targetObservation !== null && !observation(value.targetObservation)
    || typeof value.sourceAbsent !== 'boolean' || !identity(value.sourceIdentity) || !identity(value.targetIdentity) || !attributes(value.attributes)) return false;
  const frozen = value.frozen as dto.LocalRelocationFrozenResource;
  if (!frozen || !id(frozen.resourceId) || frozen.source.sourceRootId !== value.sourceRoot.id || frozen.target.sourceRootId !== value.targetRoot.id
    || frozen.before.sha256 !== value.sourceObservation.sha256 || frozen.before.bytes !== String(value.sourceObservation.bytes)
    || frozen.sourceObservationFingerprint !== relocationHash(value.sourceObservation) || frozen.attributesFingerprint !== relocationHash(value.attributes)) return false;
  if (Object.hasOwn(value, 'storage')) {
    const storage = value.storage;
    if (!record(storage, ['resourceId', 'sourcePrivateRoot', 'targetPrivateRoot', 'backup', 'quarantine', 'stage']) || storage.resourceId !== frozen.resourceId
      || !root(storage.sourcePrivateRoot) || !root(storage.targetPrivateRoot)
      || storage.backup !== `${frozen.resourceId}.backup` || storage.quarantine !== `${frozen.resourceId}.capture` || storage.stage !== `${frozen.resourceId}.stage`
      || !Object.hasOwn(value, 'recovery') && (storage.sourcePrivateRoot.dev !== value.sourceRoot.dev || storage.targetPrivateRoot.dev !== value.targetRoot.dev)) return false;
  }
  if (Object.hasOwn(value, 'recovery')) {
    const recovery = value.recovery;
    if (value.sourceObservationOrigin !== 'AUTHENTICATED_RECOVERY_MATERIAL_FD' || !record(recovery, ['originPlanId', 'originResourceId', 'material', 'target', 'retainedSource'])
      || ![recovery.originPlanId, recovery.originResourceId].every(id) || !record(recovery.material, ['root', 'relative', 'observation'])
      || !root(recovery.material.root) || !dto.isLocalRelocationRelative(recovery.material.relative, false) || !observation(recovery.material.observation)
      || !equal(recovery.material.observation, value.sourceObservation)) return false;
    if (recovery.target !== null && (!record(recovery.target, ['observation', 'aliases']) || !observation(recovery.target.observation, true)
      || !array(recovery.target.aliases, 1) || !recovery.target.aliases.every(alias => record(alias, ['root', 'relative']) && root(alias.root) && dto.isLocalRelocationRelative(alias.relative, false))
      || Number(recovery.target.observation.links) !== recovery.target.aliases.length + 1)) return false;
    if (recovery.retainedSource !== null && (!record(recovery.retainedSource, ['root', 'endpoint', 'observation', 'identity']) || !root(recovery.retainedSource.root)
      || !record(recovery.retainedSource.endpoint, ['libraryRootId', 'sourceRootId', 'relative', 'expectedRootRevision'])
      || !id(recovery.retainedSource.endpoint.libraryRootId) || !id(recovery.retainedSource.endpoint.sourceRootId)
      || !revision(recovery.retainedSource.endpoint.expectedRootRevision) || !dto.isLocalRelocationRelative(recovery.retainedSource.endpoint.relative, false)
      || !observation(recovery.retainedSource.observation) || !identity(recovery.retainedSource.identity)
      || recovery.retainedSource.root.id !== recovery.retainedSource.endpoint.sourceRootId
      || recovery.retainedSource.root.dev !== recovery.retainedSource.observation.physical.dev
      || recovery.retainedSource.endpoint.sourceRootId === frozen.target.sourceRootId && recovery.retainedSource.endpoint.relative === frozen.target.relative)) return false;
  } else {
    if (value.sourceAbsent && (frozen.action !== 'retain' || frozen.role !== 'AUDIO' || !value.targetObservation || !equal(value.sourceObservation, value.targetObservation))) return false;
    if (value.sourceObservationOrigin !== (value.sourceAbsent ? 'CANDIDATE_FD_MATCHING_CATALOG_SHA256' : 'CURRENT_SOURCE_FD')) return false;
  }
  return value.rewriteMaterial === null ? frozen.action !== 'rewrite-reference' : record(value.rewriteMaterial, ['path', 'sha256', 'bytes'])
    && dto.isLocalRelocationMainAbsolutePath(value.rewriteMaterial.path) && hash(value.rewriteMaterial.sha256) && integer(value.rewriteMaterial.bytes, 0, dto.LOCAL_RELOCATION_PLAN_BUDGET.singleSourceBytes)
    && frozen.action === 'rewrite-reference' && frozen.after.sha256 === value.rewriteMaterial.sha256 && frozen.after.bytes === String(value.rewriteMaterial.bytes);
}
function scanFact(value: unknown): value is RelocationBoundScanFact {
  if (!record(value, ['operationId', 'resourceId', 'origin', 'state']) || ![value.operationId, value.resourceId].every(id)
    || !record(value.origin, ['job', 'batchId', 'startCommandId', 'startFingerprint', 'resumeCommandId', 'resumeFingerprint', 'prepareCommandId', 'prepareFingerprint', 'commitCommandId', 'commitFingerprint', 'checkpointId', 'itemIndex'])
    || !dto.isScanJobRecord(value.origin.job) || value.origin.job.phase !== 'completed' || value.origin.job.jobRevision !== '3'
    || ![value.origin.batchId, value.origin.startCommandId, value.origin.resumeCommandId, value.origin.prepareCommandId, value.origin.commitCommandId, value.origin.checkpointId].every(id)
    || ![value.origin.startFingerprint, value.origin.resumeFingerprint, value.origin.prepareFingerprint, value.origin.commitFingerprint].every(hash)
    || !integer(value.origin.itemIndex, 0, 99) || !record(value.state, ['libraryRootId', 'relative', 'signature', 'parserVersion', 'outcome', 'assetId', 'trackId', 'failureCode', 'readFacts'])
    || ![value.state.libraryRootId, value.state.assetId, value.state.trackId].every(id) || !dto.isLocalRelocationRelative(value.state.relative, false)
    || typeof value.state.signature !== 'string' || value.state.signature.length > 256 || typeof value.state.parserVersion !== 'string'
    || value.state.outcome !== 'accepted' || value.state.failureCode !== null || !record(value.state.readFacts, ['technical', 'coverEvidence', 'readEvidence'])) return false;
  const evidence = value.state.readFacts.readEvidence;
  return record(evidence, ['bytesRead', 'readCalls', 'maxReadBytes', 'allocationBytes', 'elapsedMs', 'wholeAudioHash', 'wholeAudioDecode'])
    && integer(evidence.bytesRead, 0, 33_554_432) && integer(evidence.readCalls) && integer(evidence.maxReadBytes, 0, 8_388_608) && integer(evidence.allocationBytes, 0, 67_108_864)
    && typeof evidence.elapsedMs === 'number' && Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs >= 0 && evidence.wholeAudioHash === false && evidence.wholeAudioDecode === false;
}
function locationFact(value: unknown): value is RelocationLocationFact {
  if (!record(value, ['operationId', 'resourceId', 'planHash', 'resourceClosureHash', 'beforeAsset', 'afterAsset', 'tracks', 'catalogSha256', 'source', 'target', 'sourceObservation', 'targetObservation', 'scan'])
    || ![value.operationId, value.resourceId].every(id) || ![value.planHash, value.resourceClosureHash].every(hash) || !dto.isAudioAsset(value.beforeAsset) || !dto.isAudioAsset(value.afterAsset)
    || !endpoint(value.source) || !endpoint(value.target) || !observation(value.sourceObservation) || !observation(value.targetObservation) || !scanFact(value.scan)
    || !array(value.tracks, 200) || !value.tracks.length) return false;
  const a = value.beforeAsset, b = value.afterAsset, s = value.source, t = value.target, scan = value.scan, tracks = value.tracks;
  if (!tracks.every(track => dto.isLocalTrack(track) && track.assetId === a.id)
    || new Set(tracks.map(track => (track as dto.LocalTrack).id)).size !== tracks.length) return false;
  return a.id === b.id && a.fileRevision === b.fileRevision && a.sampleFrames === b.sampleFrames && a.timebaseHz === b.timebaseHz
    && BigInt(b.locationRevision) === BigInt(a.locationRevision) + 1n && a.libraryRootId === s.libraryRootId && a.sourceRootId === s.sourceRootId && a.rootRevision === s.rootRevision
    && b.libraryRootId === t.libraryRootId && b.sourceRootId === t.sourceRootId && b.rootRevision === t.rootRevision
    && value.sourceObservation.sha256 === value.targetObservation.sha256 && value.sourceObservation.bytes === value.targetObservation.bytes
    && (value.catalogSha256 === null || value.catalogSha256 === value.sourceObservation.sha256)
    && scan.operationId === value.operationId && scan.resourceId === value.resourceId && scan.state.assetId === b.id && tracks.some(track => dto.isLocalTrack(track) && track.id === scan.state.trackId)
    && scan.state.libraryRootId === t.libraryRootId && scan.state.relative === t.relative && scan.state.signature === value.targetObservation.signature
    && scan.origin.job.libraryRootId === t.libraryRootId && scan.origin.job.sourceRootId === t.sourceRootId && scan.origin.job.rootRevision === t.rootRevision;
}
const eventKeys = ['version', 'eventId', 'datasetId', 'planId', 'occurredAt', 'eventHash', 'kind'];
export function isRelocationEvent(input: unknown): input is RelocationEvent {
  try {
    const value = journalSnapshot(input) as Record<string, unknown>;
    if (!value || value.version !== 1 || !id(value.eventId) || !dto.isLocalRelocationPlanDatasetId(value.datasetId)
      || value.planId !== null && !id(value.planId) || !dto.isLocalRelocationPlanDate(value.occurredAt) || !hash(value.eventHash)) return false;
    let keys: string[] = [];
    switch (value.kind) {
      case 'receipt':
        keys = ['command', 'request', 'requestFingerprint', 'receipt', 'header', 'ownerEpoch'];
        if (!dto.isLocalRelocationPlanReceiptCommand(value.command) || !dto.isLocalRelocationPlanCommandPayload(value.command, value.request)
          || !dto.isLocalRelocationPlanCommandResult(value.command, value.receipt) || !id(value.ownerEpoch)) return false;
        if (relocationRequestFingerprint(value.command, value.request as never) !== value.requestFingerprint) return false;
        if ((value.request as { datasetId: string }).datasetId !== value.datasetId || (value.receipt as dto.LocalRelocationPlanReceipt).commandId !== (value.request as { commandId: string }).commandId
          || (value.receipt as dto.LocalRelocationPlanReceipt).requestFingerprint !== value.requestFingerprint || (value.receipt as dto.LocalRelocationPlanReceipt).planId !== value.planId) return false;
        if (value.header !== null && (!dto.isLocalRelocationPlan(value.header) || value.command !== 'localRelocationPlan.preview'
          || value.header.planId !== value.planId || value.header.datasetId !== value.datasetId || value.header.state !== 'PREVIEWING' || value.header.items.length || value.header.resources.length || value.header.referenceEdges.length)) return false;
        break;
      case 'operation':
        keys = ['index', 'value'];
        if (!integer(value.index, 0, 99) || !record(value.value, ['operation', 'item', 'source']) || value.value.source !== null && !catalogSnapshot(value.value.source)) return false;
        break;
      case 'root-mapping': keys = ['index', 'value']; if (!integer(value.index, 0, 15)) return false; break;
      case 'resource': keys = ['index', 'value', 'resource']; if (!integer(value.index, 0, 255) || !capturedResource(value.value)) return false; break;
      case 'reference-edge': keys = ['index', 'value']; if (!integer(value.index, 0, 511)) return false; break;
      case 'ready':
        keys = ['header', 'closureComplete', 'closureFingerprint', 'context', 'planHash', 'contextFingerprint'];
        if (!record(value.header, ['version', 'domain', 'createdAt', 'intent', 'sourceRetention', 'guards']) || value.closureComplete !== true || !hash(value.closureFingerprint)
          || !dto.isLocalRelocationFrozenContext(value.context) || !hash(value.planHash) || relocationContextFingerprint(value.context) !== value.contextFingerprint) return false;
        break;
      case 'capability': {
        keys = ['command', 'request', 'requestFingerprint', 'challenge'];
        if (value.command !== 'localRelocationPlan.confirm' && value.command !== 'localRelocationPlan.cleanup') return false;
        const command = value.command === 'localRelocationPlan.confirm' ? 'localRelocationMain.challenge' : 'localRelocationMain.challengeCleanup';
        if (!dto.isLocalRelocationPlanCommandPayload(value.command, value.request) || !dto.isLocalRelocationMainCommandResult(command, value.challenge)
          || relocationRequestFingerprint(value.command, value.request as never) !== value.requestFingerprint) return false;
        const request = value.request as dto.LocalRelocationPlanConfirm, challenge = value.challenge as dto.LocalRelocationMainChallenge;
        if (request.datasetId !== value.datasetId || request.planId !== value.planId || challenge.datasetId !== request.datasetId || challenge.commandId !== request.commandId
          || challenge.planId !== request.planId || challenge.expectedViewRevision !== request.expectedViewRevision || challenge.planHash !== request.planHash
          || challenge.contextFingerprint !== request.contextFingerprint || challenge.requestFingerprint !== value.requestFingerprint) return false;
        break;
      }
      case 'capability-consumed': keys = ['commandId', 'challengeId', 'requestFingerprint']; if (![value.commandId, value.challengeId].every(id) || !hash(value.requestFingerprint)) return false; break;
      case 'state': keys = ['state', 'issues', 'cleanup', 'recoveryChoices']; if (!(dto.LOCAL_RELOCATION_PLAN_STATES as readonly unknown[]).includes(value.state) || !array(value.issues, 256) || !value.issues.every(dto.isLocalRelocationPlanIssue)) return false; break;
      case 'phase':
        keys = ['fact', 'resource'];
        if (!record(value.fact, ['operationId', 'resourceId', 'phase', 'sourceObservation', 'targetObservation', 'stage', 'quarantine', 'retained', 'quiet']) || ![value.fact.operationId, value.fact.resourceId].every(id)
          || !(dto.LOCAL_RELOCATION_PLAN_PHASES as readonly unknown[]).includes(value.fact.phase) || value.fact.sourceObservation !== null && !observation(value.fact.sourceObservation)
          || value.fact.targetObservation !== null && !observation(value.fact.targetObservation) || ![value.fact.stage, value.fact.quarantine, value.fact.retained].every(name => name === null || dto.isLocalRelocationMainAbsolutePath(name))
          || typeof value.fact.quiet !== 'boolean') return false;
        break;
      case 'location-facts': keys = ['fact']; if (!locationFact(value.fact)) return false; break;
      case 'root-facts':
        keys = ['beforeRoot', 'afterRoot', 'planHash'];
        if (!dto.isLibraryRoot(value.beforeRoot) || !dto.isLibraryRoot(value.afterRoot) || value.beforeRoot.id !== value.afterRoot.id
          || value.beforeRoot.role !== value.afterRoot.role || BigInt(value.afterRoot.revision) !== BigInt(value.beforeRoot.revision) + 1n || !hash(value.planHash)) return false;
        break;
      case 'recovery-origin': {
        keys = ['value'];
        const origin = value.value;
        if (!record(origin, ['originPlanId', 'originPlanHash', 'originViewRevision', 'originJournalSequence', 'familyRootPlanId', 'action', 'recoveryFingerprint', 'destination', 'operationMappings'])
          || ![origin.originPlanId, origin.familyRootPlanId].every(id) || ![origin.originPlanHash, origin.recoveryFingerprint].every(hash)
          || ![origin.originViewRevision, origin.originJournalSequence].every(revision) || !['reconcile', 'rollback', 'keep-target'].includes(String(origin.action))
          || !['source', 'target'].includes(String(origin.destination)) || origin.action === 'rollback' && origin.destination !== 'source' || origin.action === 'keep-target' && origin.destination !== 'target'
          || !array(origin.operationMappings, 100) || !origin.operationMappings.length
          || !origin.operationMappings.every(mapping => record(mapping, ['originOperationId', 'operationId']) && [mapping.originOperationId, mapping.operationId].every(id))) return false;
        break;
      }
      case 'recovery-resolved':
        keys = ['resourceId', 'recoveryPlanId', 'recoveryResourceId', 'recoveryPlanHash', 'quiet'];
        if (![value.resourceId, value.recoveryPlanId, value.recoveryResourceId].every(id) || !hash(value.recoveryPlanHash) || value.quiet !== true) return false;
        break;
      case 'policy-quiet': keys = ['policy']; if (value.planId !== null || !record(value.policy, ['enabled', 'revision', 'draining']) || value.policy.enabled !== false || value.policy.draining !== false || !revision(value.policy.revision)) return false; break;
      default: return false;
    }
    if (!record(value, [...eventKeys, ...keys]) || value.planId === null && !['receipt', 'policy-quiet'].includes(String(value.kind))) return false;
    const { eventHash, ...body } = value;
    return relocationHash(body) === eventHash;
  } catch { return false; }
}
export const relocationLedgerId = (event: RelocationEvent): string => event.kind === 'receipt' ? event.request.commandId : event.eventId;
export const relocationLedgerFingerprint = (event: RelocationEvent): string => event.kind === 'receipt' ? event.requestFingerprint : event.eventHash;
export function relocationLedgerRow(event: RelocationEvent): Record<string, string> {
  if (!isRelocationEvent(event)) return corrupt();
  const row = { command_id: relocationLedgerId(event), fingerprint: relocationLedgerFingerprint(event), operation: LOCAL_RELOCATION_OPERATION,
    request: relocationCanonical(event), result: relocationCanonical({ version: 1, eventId: event.eventId, eventHash: event.eventHash }), created_at: event.occurredAt };
  const bytes = Object.values(row).reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
  if (bytes > (event.kind === 'phase' ? RELOCATION_PHASE_ROW_BYTES : RELOCATION_LEDGER_ROW_BYTES)) return relocationFail('OVER_BUDGET');
  return row;
}
export function readRelocationEvent(row: Record<string, unknown>): RelocationEvent {
  try {
    if (row.operation !== LOCAL_RELOCATION_OPERATION || typeof row.request !== 'string') return corrupt();
    const parsed: unknown = JSON.parse(row.request); if (!isRelocationEvent(parsed)) return corrupt();
    const event = journalSnapshot(parsed) as RelocationEvent, expected = relocationLedgerRow(event);
    if (Object.keys(expected).some(key => row[key] !== expected[key])) return corrupt();
    return event;
  } catch { return corrupt(); }
}
export function relocationFrozenBody(stored: RelocationStoredPlan, ready = stored.ready): dto.LocalRelocationFrozenBody {
  if (!ready) return corrupt();
  return dto.localRelocationFrozenBodySnapshot({ ...ready.header, operations: stored.operations.map(value => value.operation), rootMappings: stored.rootMappings,
    resourceClosure: { complete: ready.closureComplete, resources: stored.resources.map(value => value.frozen), referenceEdges: stored.edges, fingerprint: ready.closureFingerprint } });
}
function bump(plan: dto.LocalRelocationPlan): void {
  const viewRevision = String(BigInt(plan.viewRevision) + 1n), sequence = String(BigInt(plan.journalSequence) + 1n);
  if (!revision(viewRevision) || !revision(sequence)) return corrupt();
  plan.viewRevision = viewRevision; plan.journalSequence = sequence;
}
export function projectRelocationEvent(projection: RelocationProjection, event: RelocationEvent, ordinal: number): void {
  if (!integer(ordinal, 1) || ordinal <= projection.highWater || projection.ids.has(event.eventId)) return corrupt();
  const row = relocationLedgerRow(event), bytes = Object.values(row).reduce((total, value) => total + Buffer.byteLength(value), 0);
  if (projection.bytes + bytes > dto.LOCAL_RELOCATION_PLAN_BUDGET.journalProjectionBytes) return relocationFail('OVER_BUDGET');
  if (event.kind === 'receipt') {
    if (projection.receipts.has(event.request.commandId)) return corrupt();
    projection.receipts.set(event.request.commandId, event);
    if (event.receipt.policy) {
      const previous = relocationPolicy(projection, event.datasetId), request = event.request as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.setPolicy'];
      if (event.command !== 'localRelocationPlan.setPolicy' || request.expectedPolicyRevision !== previous.revision || BigInt(event.receipt.policy.revision) !== BigInt(previous.revision) + 1n) return corrupt();
      projection.policy.set(event.datasetId, structuredClone(event.receipt.policy));
    }
    if (event.header) {
      if (projection.plans.has(event.header.planId)) return corrupt();
      projection.plans.set(event.header.planId, { plan: structuredClone(event.header), ownerEpoch: event.ownerEpoch, operations: [], rootMappings: [], resources: [], edges: [], ready: null, events: [], phaseCounts: new Map(), recoveryOrigin: null, resolvedResources: new Set() });
    }
  } else if (event.kind === 'policy-quiet') {
    const previous = relocationPolicy(projection, event.datasetId);
    if (previous.enabled || !previous.draining || previous.revision !== event.policy.revision) return corrupt();
    projection.policy.set(event.datasetId, structuredClone(event.policy));
  } else {
    const stored = event.planId ? projection.plans.get(event.planId) : undefined;
    if (!stored || stored.plan.datasetId !== event.datasetId || stored.events.length >= dto.LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerPlan) return corrupt();
    if (['operation', 'root-mapping', 'resource', 'reference-edge', 'recovery-origin'].includes(event.kind) && (stored.ready !== null || stored.plan.state !== 'PREVIEWING')) return corrupt();
    if (event.kind === 'operation') { if (event.index !== stored.operations.length) return corrupt(); stored.operations.push(structuredClone(event.value)); }
    else if (event.kind === 'root-mapping') { if (event.index !== stored.rootMappings.length) return corrupt(); stored.rootMappings.push(structuredClone(event.value)); }
    else if (event.kind === 'resource') { if (event.index !== stored.resources.length) return corrupt(); stored.resources.push(structuredClone(event.value)); }
    else if (event.kind === 'reference-edge') { if (event.index !== stored.edges.length) return corrupt(); stored.edges.push(structuredClone(event.value)); }
    else if (event.kind === 'ready') {
      if (stored.ready || stored.ownerEpoch !== event.context.ownerEpoch || event.context.datasetId !== event.datasetId || event.context.planId !== event.planId) return corrupt();
      const frozen = relocationFrozenBody(stored, event); dto.localRelocationFrozenPlanSnapshot(frozen, event.context);
      if (stored.plan.intent.kind === 'recovery') {
        const origin = stored.recoveryOrigin, parent = origin ? projection.plans.get(origin.originPlanId) : null;
        if (!origin || !parent?.ready || origin.operationMappings.length !== parent.operations.length || stored.operations.length !== parent.operations.length
          || stored.resources.length !== parent.resources.length || new Set(origin.operationMappings.map(value => value.operationId)).size !== stored.operations.length
          || new Set(origin.operationMappings.map(value => value.originOperationId)).size !== parent.operations.length
          || origin.operationMappings.some(mapping => !parent.operations.some(value => value.operation.operationId === mapping.originOperationId)
            || !stored.operations.some(value => value.operation.operationId === mapping.operationId))
          || !equal([...stored.resources.map(value => value.recovery?.originResourceId)].sort(), [...parent.resources.map(value => value.frozen.resourceId)].sort())) return corrupt();
        const familyRoot = projection.plans.get(origin.familyRootPlanId);
        if (!familyRoot?.ready) return corrupt();
        for (const mapping of origin.operationMappings) {
          const before = parent.operations.find(value => value.operation.operationId === mapping.originOperationId)!, after = stored.operations.find(value => value.operation.operationId === mapping.operationId)!;
          if (before.operation.assetId !== after.operation.assetId || !equal(before.operation.trackIds, after.operation.trackIds)
            || before.operation.expectedFileRevision !== after.operation.expectedFileRevision || !equal(before.operation.resourceIds, after.operation.resourceIds)) return corrupt();
        }
        for (const resource of stored.resources) {
          const proof = resource.recovery, original = familyRoot.resources.find(value => value.frozen.resourceId === resource.frozen.resourceId);
          if (!proof || proof.originPlanId !== parent.plan.planId || !original
            || !(resource.sourceObservation.sha256 === original.frozen.before.sha256 && resource.sourceObservation.bytes === Number(original.frozen.before.bytes)
              || resource.sourceObservation.sha256 === original.frozen.after.sha256 && resource.sourceObservation.bytes === Number(original.frozen.after.bytes))
            || resource.frozen.role !== original.frozen.role) return corrupt();
          if (!equal(resource.storage ?? null, original.storage ?? null)) return corrupt();
          const materialName = `${proof.material.root.path}/${proof.material.relative}`;
          const ancestors = relocationRecoveryFamily(projection, parent.plan.planId);
          const authorizedMaterial = materialName === `${original.sourceRoot.path}/${original.frozen.source.relative}` || materialName === `${original.targetRoot.path}/${original.frozen.target.relative}`
            || original.rewriteMaterial?.path === materialName || ancestors.some(value => value.events.some(event => event.kind === 'phase' && event.fact.resourceId === original.frozen.resourceId
              && [event.fact.stage, event.fact.quarantine, event.fact.retained].includes(materialName)))
            || original.storage && [`${original.storage.sourcePrivateRoot.path}/${original.storage.backup}`, `${original.storage.sourcePrivateRoot.path}/${original.storage.quarantine}`,
              `${original.storage.targetPrivateRoot.path}/${original.storage.stage}`].includes(materialName);
          if (!authorizedMaterial) return corrupt();
          const expected = origin.destination === 'source' ? original.frozen.before : original.frozen.after;
          if (!equal(resource.frozen.after, expected) || resource.frozen.role === 'AUDIO' && !equal(resource.frozen.before, resource.frozen.after)) return corrupt();
          const retained = proof.retainedSource, side = origin.destination === 'source' ? 'target' : 'source';
          if (retained) {
            const endpoint = original.frozen[side], root = side === 'source' ? original.sourceRoot : original.targetRoot, bytes = side === 'source' ? original.frozen.before : original.frozen.after;
            const authenticated = side === 'source' && !original.sourceAbsent && equal(retained.observation.physical, original.sourceObservation.physical) && retained.observation.birthtimeNs === original.sourceObservation.birthtimeNs
              || ancestors.some(value => value.resources.some(resource => resource.frozen.resourceId === original.frozen.resourceId && resource.frozen.target.sourceRootId === endpoint.sourceRootId
                && resource.frozen.target.relative === endpoint.relative) && value.events.some(event => event.kind === 'phase' && event.fact.resourceId === original.frozen.resourceId && event.fact.targetObservation
                  && equal(event.fact.targetObservation.physical, retained.observation.physical) && event.fact.targetObservation.birthtimeNs === retained.observation.birthtimeNs
                  && event.fact.targetObservation.sha256 === retained.observation.sha256 && event.fact.targetObservation.bytes === retained.observation.bytes));
            if (!equal(retained.root, root) || retained.endpoint.sourceRootId !== endpoint.sourceRootId || retained.endpoint.libraryRootId !== endpoint.libraryRootId
              || retained.endpoint.relative !== endpoint.relative || retained.observation.sha256 !== bytes.sha256 || String(retained.observation.bytes) !== bytes.bytes || !authenticated
              || !equal(retained.identity, side === 'source' ? original.sourceIdentity : original.targetIdentity)) return corrupt();
          }
        }
      } else if (stored.recoveryOrigin || stored.resources.some(value => value.recovery)) return corrupt();
      for (const resource of stored.resources.filter(value => value.sourceAbsent && !value.recovery)) {
        const operation = stored.operations.find(value => value.operation.operationId === resource.frozen.operationIds[0]);
        if (!operation?.source || !['locate', 'root-reassociate'].includes(operation.operation.kind)
          || operation.source.catalogSha256 === null || operation.source.catalogSha256 !== resource.sourceObservation.sha256) return corrupt();
      }
      if (relocationPlanHash(frozen) !== event.planHash || !equal(frozen.intent, stored.plan.intent) || event.header.createdAt !== stored.plan.createdAt) return corrupt();
      stored.ready = event;
      stored.plan.items = structuredClone(stored.operations.map(value => value.item));
      stored.plan.resources = structuredClone(stored.events.filter((value): value is Extract<RelocationEvent, { kind: 'resource' }> => value.kind === 'resource').map(value => value.resource));
      stored.plan.referenceEdges = structuredClone(stored.edges);
      stored.plan.planHash = event.planHash; stored.plan.contextFingerprint = event.contextFingerprint; stored.plan.state = 'READY';
      stored.plan.closure = { complete: true, operationCount: stored.operations.length, resourceCount: stored.resources.length, referenceEdgeCount: stored.edges.length,
        rootCount: new Set(frozen.rootMappings.flatMap(value => [`${value.source.libraryRootId}:${value.source.sourceRootId}`, `${value.target.libraryRootId}:${value.target.sourceRootId}`])).size, fingerprint: event.closureFingerprint,
        totalSourceBytes: String(stored.resources.reduce((total, value) => total + BigInt(value.frozen.before.bytes), 0n)), spaceVerified: true, protection: 'verified' };
    } else if (event.kind === 'recovery-origin') {
      const origin = event.value, parent = projection.plans.get(origin.originPlanId), intent = stored.plan.intent;
      if (stored.recoveryOrigin || intent.kind !== 'recovery' || !parent?.ready || parent.plan.datasetId !== event.datasetId
        || intent.originPlanId !== origin.originPlanId || intent.expectedOriginViewRevision !== origin.originViewRevision
        || intent.recoveryFingerprint !== origin.recoveryFingerprint || parent.plan.viewRevision !== origin.originViewRevision
        || parent.plan.journalSequence !== origin.originJournalSequence || parent.plan.planHash !== origin.originPlanHash
        || relocationRecoveryFamily(projection, origin.originPlanId)[0]?.plan.planId !== origin.familyRootPlanId
        || origin.recoveryFingerprint !== relocationRecoveryFingerprint(relocationRecoveryFamily(projection, origin.originPlanId))
        || intent.choiceId !== relocationRecoveryChoiceId(parent.plan.planId, origin.recoveryFingerprint, origin.action)
        || !relocationUnresolvedResources(parent).length && !['RECOVERY_REQUIRED', 'RUNNING', 'QUEUED', 'CANCEL_REQUESTED'].includes(parent.plan.state)) return corrupt();
      stored.recoveryOrigin = structuredClone(origin);
    } else if (event.kind === 'capability') {
      if (!stored.ready || projection.receipts.has(event.request.commandId) || projection.capabilities.has(event.request.commandId) || event.challenge.planHash !== stored.plan.planHash
          || event.challenge.contextFingerprint !== stored.plan.contextFingerprint || event.challenge.policyRevision !== stored.plan.policyRevision
          || event.command === 'localRelocationPlan.confirm' && event.challenge.grant.ownerEpoch !== stored.ownerEpoch) return corrupt();
      projection.capabilities.set(event.request.commandId, { issued: event, consumed: false });
    } else if (event.kind === 'capability-consumed') {
      const issued = projection.capabilities.get(event.commandId);
      if (!issued || issued.consumed || issued.issued.planId !== event.planId || issued.issued.challenge.grant.challengeId !== event.challengeId || issued.issued.requestFingerprint !== event.requestFingerprint) return corrupt();
      issued.consumed = true;
    } else if (event.kind === 'state') {
      stored.plan.state = event.state; stored.plan.issues = structuredClone(event.issues); stored.plan.cleanup = structuredClone(event.cleanup); stored.plan.recoveryChoices = structuredClone(event.recoveryChoices);
    } else if (event.kind === 'phase') {
      const index = stored.resources.findIndex(value => value.frozen.resourceId === event.fact.resourceId), original = stored.resources[index];
      if (!stored.ready || !original || !original.frozen.operationIds.includes(event.fact.operationId) || event.resource.resourceId !== event.fact.resourceId) return corrupt();
      const count = (stored.phaseCounts.get(event.fact.resourceId) ?? 0) + 1;
      if (count > dto.LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerResource) return relocationFail('OVER_BUDGET');
      stored.phaseCounts.set(event.fact.resourceId, count);
      const { state: _state, phase: _phase, verification: _verify, sourceHandling: _source, issue: _issue, ...fixed } = event.resource;
      const prior = stored.plan.resources[index]!;
      const { state: _oldState, phase: _oldPhase, verification: _oldVerify, sourceHandling: _oldSource, issue: _oldIssue, ...oldFixed } = prior;
      if (!equal(fixed, oldFixed) || event.resource.phase !== event.fact.phase) return corrupt();
      stored.plan.resources[index] = structuredClone(event.resource);
      for (const item of stored.plan.items.filter(value => value.resourceIds.includes(event.fact.resourceId))) {
        const all = item.resourceIds.map(resourceId => stored.plan.resources.find(value => value.resourceId === resourceId)!);
        item.phase = event.fact.phase;
        item.state = all.every(value => ['registered', 'retained', 'cleaned', 'unchanged'].includes(value.state)) ? 'registered' : event.resource.state;
        item.issue = event.resource.issue;
      }
      const retainedSource = original.recovery?.retainedSource, source = retainedSource?.endpoint ?? original.frozen.source;
      const sourceKey = `${event.datasetId}/${source.sourceRootId}/${source.relative}`;
      if (['REGISTERED', 'SOURCE_RETAINED'].includes(event.fact.phase) && event.fact.targetObservation?.sha256 === original.frozen.after.sha256)
        projection.retainedSources.delete(`${event.datasetId}/${original.frozen.target.sourceRootId}/${original.frozen.target.relative}`);
      if (event.fact.phase === 'SOURCE_RETAINED') {
        const inheritedRegistration = stored.recoveryOrigin?.action === 'reconcile' && relocationRecoveryFamily(projection, stored.plan.planId).some(value => value.plan.planId !== stored.plan.planId
          && value.events.some(event => event.kind === 'location-facts' && event.fact.resourceId === original.frozen.resourceId && event.fact.target.relative === original.frozen.target.relative
            && event.fact.target.sourceRootId === original.frozen.target.sourceRootId));
        if (original.sourceAbsent || !event.fact.targetObservation || event.fact.targetObservation.sha256 !== original.frozen.after.sha256
          || !stored.events.some(value => value.kind === 'location-facts' && value.fact.resourceId === event.fact.resourceId) && !inheritedRegistration && original.frozen.role === 'AUDIO') return corrupt();
        projection.retainedSources.set(sourceKey, { datasetId: event.datasetId, planId: stored.plan.planId, operationId: event.fact.operationId, resourceId: event.fact.resourceId,
          source, observation: retainedSource?.observation ?? original.sourceObservation, target: original.frozen.target, planHash: stored.plan.planHash, ledgerOrdinal: ordinal });
      } else if (event.fact.phase === 'SOURCE_REMOVED') projection.retainedSources.delete(sourceKey);
    } else if (event.kind === 'location-facts') {
      const resource = stored.resources.find(value => value.frozen.resourceId === event.fact.resourceId);
      const operation = stored.operations.find(value => value.operation.operationId === event.fact.operationId);
      if (!stored.ready || !resource || !operation?.source || event.fact.planHash !== stored.plan.planHash || event.fact.resourceClosureHash !== stored.plan.closure.fingerprint
        || !equal(event.fact.beforeAsset, operation.source.asset) || !equal(event.fact.tracks, operation.source.tracks) || event.fact.catalogSha256 !== operation.source.catalogSha256
        || !equal(event.fact.sourceObservation, resource.sourceObservation)
        || event.fact.sourceObservation.sha256 !== resource.frozen.before.sha256 || event.fact.targetObservation.sha256 !== resource.frozen.after.sha256
        || event.fact.source.relative !== resource.frozen.source.relative || event.fact.target.relative !== resource.frozen.target.relative) return corrupt();
      projection.locationFacts.set(`${event.fact.target.libraryRootId}/${event.fact.target.relative}`, { fact: event.fact, ledgerOrdinal: ordinal });
      projection.latestAssets.set(event.fact.afterAsset.id, { asset: event.fact.afterAsset, relative: event.fact.target.relative, catalogSha256: event.fact.catalogSha256, ledgerOrdinal: ordinal });
      // 被真实CAS登记为当前位置的名字不再是旧代保留副本；旧SOURCE_RETAINED历史行仍不可变。
      projection.retainedSources.delete(`${event.datasetId}/${event.fact.target.sourceRootId}/${event.fact.target.relative}`);
    } else if (event.kind === 'root-facts') {
      if (!stored.ready || event.planHash !== stored.plan.planHash || stored.plan.intent.kind !== 'root-reassociate' && !stored.recoveryOrigin) return corrupt();
      projection.latestRoots.set(event.afterRoot.id, { root: event.afterRoot, ledgerOrdinal: ordinal });
    } else if (event.kind === 'recovery-resolved') {
      const recovery = projection.plans.get(event.recoveryPlanId), family = recovery ? relocationRecoveryFamily(projection, recovery.plan.planId) : [];
      if (!stored.ready || !recovery?.ready || !recovery.recoveryOrigin || recovery.plan.planHash !== event.recoveryPlanHash
        || !family.some(value => value.plan.planId === stored.plan.planId) || stored.plan.planId === recovery.plan.planId
        || !stored.resources.some(value => value.frozen.resourceId === event.resourceId) || event.resourceId !== event.recoveryResourceId
        || stored.resolvedResources.has(event.resourceId)) return corrupt();
      const terminal = [...recovery.events].reverse().find(value => value.kind === 'phase' && value.fact.resourceId === event.recoveryResourceId);
      if (!terminal || terminal.kind !== 'phase' || terminal.fact.quiet !== true || terminal.fact.phase !== 'TERMINAL') return corrupt();
      const original = family[0]!.resources.find(value => value.frozen.resourceId === event.resourceId), target = terminal.fact.targetObservation;
      const expected = recovery.recoveryOrigin.destination === 'source' ? original?.frozen.before : original?.frozen.after;
      if (!expected || !target || target.sha256 !== expected.sha256 || String(target.bytes) !== expected.bytes) return corrupt();
      if (original!.frozen.role === 'AUDIO' && recovery.recoveryOrigin.action !== 'reconcile'
        && !recovery.events.some(value => value.kind === 'location-facts' && value.fact.resourceId === event.recoveryResourceId)) return corrupt();
      if (original!.frozen.role === 'AUDIO' && recovery.recoveryOrigin.action === 'reconcile'
        && !family.some(plan => plan.events.some(value => value.kind === 'location-facts' && value.fact.resourceId === event.resourceId))) return corrupt();
      stored.resolvedResources.add(event.resourceId);
    }
    stored.events.push(event); bump(stored.plan);
    // 私有闭集以分行持久，尚未READY前公开投影保持完整空集合；不会向UI泄露一半资源。
    if (!dto.isLocalRelocationPlan(stored.plan)) return corrupt();
  }
  projection.ids.add(event.eventId); projection.events.push(event); projection.bytes += bytes; projection.highWater = ordinal;
  projection.fingerprint = relocationHash({ previous: projection.fingerprint, eventHash: event.eventHash, ordinal });
}
export function relocationUnresolvedResources(stored: RelocationStoredPlan): string[] {
  return stored.resources.filter(value => {
    if (stored.resolvedResources.has(value.frozen.resourceId)) return false;
    const phases = stored.events.filter((event): event is Extract<RelocationEvent, { kind: 'phase' }> => event.kind === 'phase' && event.fact.resourceId === value.frozen.resourceId);
    return phases.some(event => ['SOURCE_CAPTURED', 'TARGET_INSTALLED', 'SOURCE_REMOVED', 'UNKNOWN'].includes(event.fact.phase)) && phases.at(-1)?.fact.quiet !== true;
  }).map(value => value.frozen.resourceId);
}

/** 仅认证的父链；资源ID跨代保持，operation每代换新。冷保护从首项取得一个真组。 */
export function relocationRecoveryFamily(projection: RelocationProjection, planId: string): RelocationStoredPlan[] {
  const result: RelocationStoredPlan[] = [], seen = new Set<string>(); let cursor = projection.plans.get(planId);
  while (cursor) {
    if (seen.has(cursor.plan.planId) || result.length >= dto.LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerPlan) return corrupt();
    seen.add(cursor.plan.planId); result.unshift(cursor);
    if (!cursor.recoveryOrigin) break;
    const parent = projection.plans.get(cursor.recoveryOrigin.originPlanId);
    if (!parent?.ready || parent.plan.datasetId !== cursor.plan.datasetId || parent.plan.planHash !== cursor.recoveryOrigin.originPlanHash) return corrupt();
    cursor = parent;
  }
  if (!result.length || result[0]!.recoveryOrigin) return corrupt(); return result;
}

export function relocationRecoveryFingerprint(family: readonly RelocationStoredPlan[]): string {
  return relocationHash(family.map(stored => ({ planId: stored.plan.planId, planHash: stored.plan.planHash, viewRevision: stored.plan.viewRevision,
    journalSequence: stored.plan.journalSequence, resourceIds: stored.resources.map(resource => resource.frozen.resourceId),
    eventHashes: stored.events.map(event => event.eventHash), resolvedResourceIds: [...stored.resolvedResources].sort() })));
}
