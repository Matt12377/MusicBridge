import { isCollectionId } from './collection.js';
import { isLocalCatalogRevision, isLocalExactInteger } from './local-catalog.js';
import type { IpcFailure } from './ipc.js';
import {
  LOCAL_RELOCATION_PLAN_BUDGET, LOCAL_RELOCATION_PLAN_DOMAIN, LOCAL_RELOCATION_RESOURCE_ROLES, LOCAL_RELOCATION_REFERENCE_KINDS,
  isLocalRelocationPlanCommandPayload, isLocalRelocationPlanCommandResult, isLocalRelocationPlanDatasetId,
  isLocalRelocationPlanDate, isLocalRelocationPlanHash, isLocalRelocationPlanIntent,
  localRelocationCompletePlanWithinBudget, localRelocationDataSnapshot, localRelocationRecord,
  type LocalRelocationPlanConfirm, type LocalRelocationPlanCleanup, type LocalRelocationPlanIntent,
  type LocalRelocationPlanReceipt, type LocalRelocationResourceRole, type LocalRelocationReferenceEdge,
  type LocalRelocationSourceDisposition, type LocalRelocationTargetChoice,
} from './local-relocation-plan.js';

/** 名称只供真实 Main→Owner 专用物理端口；不进入通用 dispatchInternal。 */
export const LOCAL_RELOCATION_MAIN_COMMANDS = [
  'localRelocationMain.captureTarget', 'localRelocationMain.challenge', 'localRelocationMain.executeGranted',
  'localRelocationMain.challengeCleanup', 'localRelocationMain.cleanupGranted',
] as const;
export type LocalRelocationMainCommand = typeof LOCAL_RELOCATION_MAIN_COMMANDS[number];
export interface LocalRelocationMainCaptureTarget { datasetId: string; commandId: string; kind: 'directory' | 'file'; absolutePath: string }
/** JSON 合法不构成授权：Core 仍须核真实端口、Owner epoch、完整 challenge HMAC 与单次 nonce。 */
export interface LocalRelocationMainGrant {
  domain: typeof LOCAL_RELOCATION_PLAN_DOMAIN; action: 'execute' | 'cleanup';
  challengeId: string; ownerEpoch: string; nonce: string; authorityId: string; signature: string;
}
export interface LocalRelocationMainChallenge {
  datasetId: string; commandId: string; planId: string; expectedViewRevision: string;
  domain: typeof LOCAL_RELOCATION_PLAN_DOMAIN; action: 'execute' | 'cleanup'; planHash: string; contextFingerprint: string;
  policyRevision: string; requestFingerprint: string; verifiedTargetFingerprint: string | null;
  sourceResourceIds: string[]; expiresAt: string; grant: LocalRelocationMainGrant;
}
export interface LocalRelocationMainCommandPayloads {
  'localRelocationMain.captureTarget': LocalRelocationMainCaptureTarget;
  'localRelocationMain.challenge': { datasetId: string; confirm: LocalRelocationPlanConfirm };
  'localRelocationMain.executeGranted': { datasetId: string; confirm: LocalRelocationPlanConfirm; grant: LocalRelocationMainGrant };
  'localRelocationMain.challengeCleanup': { datasetId: string; cleanup: LocalRelocationPlanCleanup };
  'localRelocationMain.cleanupGranted': { datasetId: string; cleanup: LocalRelocationPlanCleanup; grant: LocalRelocationMainGrant };
}
export interface LocalRelocationMainCommandResults {
  'localRelocationMain.captureTarget': LocalRelocationTargetChoice;
  'localRelocationMain.challenge': LocalRelocationMainChallenge;
  'localRelocationMain.executeGranted': LocalRelocationPlanReceipt;
  'localRelocationMain.challengeCleanup': LocalRelocationMainChallenge;
  'localRelocationMain.cleanupGranted': LocalRelocationPlanReceipt;
}
export type LocalRelocationMainRequest = { [C in LocalRelocationMainCommand]: {
  version: 1; type: 'relocation-main-request'; requestId: string; sequence: number; command: C; payload: LocalRelocationMainCommandPayloads[C];
} }[LocalRelocationMainCommand];
export type LocalRelocationMainResponse = { version: 1; type: 'relocation-main-response'; requestId: string; sequence: number }
  & ({ ok: true; result: LocalRelocationMainCommandResults[LocalRelocationMainCommand] } | { ok: false; failure: IpcFailure });

/** 原字节 root 内相对名；不做 Unicode、大小写或分隔符规范化。 */
export interface LocalRelocationEndpoint { libraryRootId: string; sourceRootId: string; relative: string; expectedRootRevision: string }
export interface LocalRelocationFrozenOperation {
  operationId: string; kind: 'rename' | 'move' | 'locate' | 'root-reassociate' | 'recovery'; assetId: string | null; trackIds: string[];
  expectedFileRevision: string | null; expectedLocationRevision: string | null;
  source: LocalRelocationEndpoint; target: LocalRelocationEndpoint; resourceIds: string[];
}
export interface LocalRelocationRootMapping {
  mappingId: string; source: LocalRelocationEndpoint; target: LocalRelocationEndpoint;
  sourceCapabilityFingerprint: string; targetCapabilityFingerprint: string;
  sourcePhysicalRootFingerprint: string; targetPhysicalRootFingerprint: string;
  sourceAncestorFingerprint: string; targetAncestorFingerprint: string;
}
export interface LocalRelocationFrozenResource {
  resourceId: string; role: LocalRelocationResourceRole; operationIds: string[];
  source: LocalRelocationEndpoint; target: LocalRelocationEndpoint;
  action: 'move' | 'copy-retain' | 'retain' | 'rewrite-reference';
  before: { sha256: string; bytes: string }; after: { sha256: string; bytes: string };
  sourceObservationFingerprint: string; targetObservationFingerprint: string; attributesFingerprint: string;
  sharedMemberIds: string[]; transitionNames: string[];
}
/** 九键是独立 013 body；不复用或扩展旧 012 六键 body、九键 operation、schema1。 */
export interface LocalRelocationFrozenBody {
  version: 1; domain: typeof LOCAL_RELOCATION_PLAN_DOMAIN; createdAt: string; intent: LocalRelocationPlanIntent;
  operations: LocalRelocationFrozenOperation[]; rootMappings: LocalRelocationRootMapping[];
  resourceClosure: { complete: boolean; resources: LocalRelocationFrozenResource[]; referenceEdges: LocalRelocationReferenceEdge[]; fingerprint: string };
  sourceRetention: { disposition: LocalRelocationSourceDisposition; cleanupRequiresNewGrant: true; resourceIds: string[] };
  guards: { noOverwrite: true; preserveAudioWholeBytes: true; unknownReferences: 'BLOCK'; physicalRootIdentity: 'REQUIRED'; leaseProtection: 'REQUIRED'; reservationFingerprint: string };
}
/** Scanner/readFacts/job/batch/FD/actor 不由 JSON 输入认证，opaque ticket 留在原 Owner 服务内。 */
export interface LocalRelocationFrozenContext {
  version: 1; domain: typeof LOCAL_RELOCATION_PLAN_DOMAIN; datasetId: string; planId: string; viewRevision: string;
  policyRevision: string; ownerEpoch: string; targetChoiceIds: string[]; rootObservationFingerprint: string;
  resourceObservationFingerprint: string; protectionFingerprint: string; reservationFingerprint: string; commandFingerprint: string;
}

type Data = Record<string, unknown>;
const record = localRelocationRecord;
const invalid = (): never => { throw new Error('位置计划私有端口、闭集或能力的数据无效。'); };
const values = <T extends readonly string[]>(value: unknown, allowed: T): value is T[number] => typeof value === 'string' && (allowed as readonly string[]).includes(value);
const array = (value: unknown, maximum: number = LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes): value is unknown[] => Array.isArray(value) && value.length <= maximum;
const ids = (value: unknown, minimum = 0, maximum: number = LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes): value is string[] => array(value, maximum) && value.length >= minimum && value.every(isCollectionId) && new Set(value).size === value.length;
const sequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const bytes = (value: unknown): value is string => isLocalExactInteger(value) && BigInt(value) <= BigInt(LOCAL_RELOCATION_PLAN_BUDGET.singleSourceBytes);
const nullRevision = (value: unknown): value is string | null => value === null || isLocalCatalogRevision(value);
const nullableId = (value: unknown): value is string | null => value === null || isCollectionId(value);
export const isLocalRelocationMainCommand = (value: unknown): value is LocalRelocationMainCommand => values(value, LOCAL_RELOCATION_MAIN_COMMANDS);
/** private 路径只有真 Main chooser 能提交；其底层身份须由 Core 实际 OS 观察。 */
export const isLocalRelocationMainAbsolutePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= LOCAL_RELOCATION_PLAN_BUDGET.allTextBytes
  && !/[\u0000-\u001f\u007f]/u.test(value) && (/^\//u.test(value) || /^[a-z]:[\/\\]/iu.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value));
export const isLocalRelocationRelative = (value: unknown, allowRoot = true): value is string => typeof value === 'string' && value.length <= LOCAL_RELOCATION_PLAN_BUDGET.allTextBytes
  && (allowRoot || value.length > 0) && !/[\u0000-\u001f\u007f\\:]/u.test(value) && !value.startsWith('/')
  && (value === '' || value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));

function endpoint(value: unknown): value is LocalRelocationEndpoint {
  return record(value, ['libraryRootId', 'sourceRootId', 'relative', 'expectedRootRevision']) && [value.libraryRootId, value.sourceRootId].every(isCollectionId)
    && isLocalRelocationRelative(value.relative) && isLocalCatalogRevision(value.expectedRootRevision);
}
function operation(value: unknown): value is LocalRelocationFrozenOperation {
  if (!record(value, ['operationId', 'kind', 'assetId', 'trackIds', 'expectedFileRevision', 'expectedLocationRevision', 'source', 'target', 'resourceIds']) || !isCollectionId(value.operationId)
    || !values(value.kind, ['rename', 'move', 'locate', 'root-reassociate', 'recovery'] as const) || !nullableId(value.assetId) || !ids(value.trackIds)
    || !nullRevision(value.expectedFileRevision) || !nullRevision(value.expectedLocationRevision) || !endpoint(value.source) || !endpoint(value.target) || !ids(value.resourceIds, 1, LOCAL_RELOCATION_PLAN_BUDGET.closedResources)) return false;
  if (value.assetId === null) return value.kind === 'root-reassociate' && value.trackIds.length === 0 && value.expectedFileRevision === null && value.expectedLocationRevision === null;
  return value.trackIds.length > 0 && isLocalCatalogRevision(value.expectedFileRevision) && isLocalCatalogRevision(value.expectedLocationRevision)
    && isLocalRelocationRelative(value.source.relative, false) && isLocalRelocationRelative(value.target.relative, false);
}
function mapping(value: unknown): value is LocalRelocationRootMapping {
  return record(value, ['mappingId', 'source', 'target', 'sourceCapabilityFingerprint', 'targetCapabilityFingerprint', 'sourcePhysicalRootFingerprint', 'targetPhysicalRootFingerprint', 'sourceAncestorFingerprint', 'targetAncestorFingerprint'])
    && isCollectionId(value.mappingId) && endpoint(value.source) && endpoint(value.target)
    && [value.sourceCapabilityFingerprint, value.targetCapabilityFingerprint, value.sourcePhysicalRootFingerprint, value.targetPhysicalRootFingerprint, value.sourceAncestorFingerprint, value.targetAncestorFingerprint].every(isLocalRelocationPlanHash);
}
function fileIdentity(value: unknown): value is { sha256: string; bytes: string } { return record(value, ['sha256', 'bytes']) && isLocalRelocationPlanHash(value.sha256) && bytes(value.bytes); }
function resource(value: unknown): value is LocalRelocationFrozenResource {
  if (!record(value, ['resourceId', 'role', 'operationIds', 'source', 'target', 'action', 'before', 'after', 'sourceObservationFingerprint', 'targetObservationFingerprint', 'attributesFingerprint', 'sharedMemberIds', 'transitionNames'])
    || !isCollectionId(value.resourceId) || !values(value.role, LOCAL_RELOCATION_RESOURCE_ROLES) || !ids(value.operationIds, 1, LOCAL_RELOCATION_PLAN_BUDGET.operations)
    || !endpoint(value.source) || !endpoint(value.target) || !isLocalRelocationRelative(value.source.relative, false) || !isLocalRelocationRelative(value.target.relative, false)
    || !values(value.action, ['move', 'copy-retain', 'retain', 'rewrite-reference'] as const) || !fileIdentity(value.before) || !fileIdentity(value.after)
    || ![value.sourceObservationFingerprint, value.targetObservationFingerprint, value.attributesFingerprint].every(isLocalRelocationPlanHash)
    || !ids(value.sharedMemberIds) || !array(value.transitionNames, LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerResource) || !value.transitionNames.every(name => isLocalRelocationRelative(name, false))
    || new Set(value.transitionNames).size !== value.transitionNames.length) return false;
  if (value.role === 'AUDIO' && (value.before.bytes === '0' || value.action === 'rewrite-reference')) return false;
  if (value.action !== 'rewrite-reference' && (value.before.sha256 !== value.after.sha256 || value.before.bytes !== value.after.bytes)) return false;
  return value.action !== 'rewrite-reference' || value.role === 'CUE' || value.role === 'MANIFEST';
}
function edge(value: unknown): value is LocalRelocationReferenceEdge {
  return record(value, ['edgeId', 'fromResourceId', 'toResourceId', 'kind', 'shared']) && [value.edgeId, value.fromResourceId, value.toResourceId].every(isCollectionId)
    && value.fromResourceId !== value.toResourceId && values(value.kind, LOCAL_RELOCATION_REFERENCE_KINDS) && typeof value.shared === 'boolean';
}
const sameRoot = (a: LocalRelocationEndpoint, b: LocalRelocationEndpoint): boolean => a.libraryRootId === b.libraryRootId && a.sourceRootId === b.sourceRootId && a.expectedRootRevision === b.expectedRootRevision;
const sameEndpoint = (a: LocalRelocationEndpoint, b: LocalRelocationEndpoint): boolean => sameRoot(a, b) && a.relative === b.relative;
function bodyData(value: unknown): value is LocalRelocationFrozenBody {
  if (!record(value, ['version', 'domain', 'createdAt', 'intent', 'operations', 'rootMappings', 'resourceClosure', 'sourceRetention', 'guards']) || value.version !== 1 || value.domain !== LOCAL_RELOCATION_PLAN_DOMAIN
    || !isLocalRelocationPlanDate(value.createdAt) || !isLocalRelocationPlanIntent(value.intent)
    || !array(value.operations, LOCAL_RELOCATION_PLAN_BUDGET.operations) || value.operations.length === 0 || !value.operations.every(operation)
    || !array(value.rootMappings, LOCAL_RELOCATION_PLAN_BUDGET.sourceAndTargetRoots) || value.rootMappings.length === 0 || !value.rootMappings.every(mapping)) return false;
  const closure = value.resourceClosure, retention = value.sourceRetention, guards = value.guards;
  if (!record(closure, ['complete', 'resources', 'referenceEdges', 'fingerprint']) || typeof closure.complete !== 'boolean' || !isLocalRelocationPlanHash(closure.fingerprint)
    || !array(closure.resources, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || closure.resources.length === 0 || !closure.resources.every(resource)
    || !array(closure.referenceEdges, LOCAL_RELOCATION_PLAN_BUDGET.referenceEdges) || !closure.referenceEdges.every(edge)
    || !record(retention, ['disposition', 'cleanupRequiresNewGrant', 'resourceIds']) || !values(retention.disposition, ['RETAIN', 'REQUEST_CLEANUP'] as const) || retention.cleanupRequiresNewGrant !== true || !ids(retention.resourceIds, 0, LOCAL_RELOCATION_PLAN_BUDGET.closedResources)
    || !record(guards, ['noOverwrite', 'preserveAudioWholeBytes', 'unknownReferences', 'physicalRootIdentity', 'leaseProtection', 'reservationFingerprint'])
    || guards.noOverwrite !== true || guards.preserveAudioWholeBytes !== true || guards.unknownReferences !== 'BLOCK' || guards.physicalRootIdentity !== 'REQUIRED' || guards.leaseProtection !== 'REQUIRED' || !isLocalRelocationPlanHash(guards.reservationFingerprint)) return false;
  const operations = value.operations as LocalRelocationFrozenOperation[], mappings = value.rootMappings as LocalRelocationRootMapping[];
  const resources = closure.resources as LocalRelocationFrozenResource[], edges = closure.referenceEdges as LocalRelocationReferenceEdge[];
  const operationIds = new Set(operations.map(item => item.operationId)), resourceIds = new Set(resources.map(item => item.resourceId));
  if (operationIds.size !== operations.length || resourceIds.size !== resources.length || new Set(mappings.map(item => item.mappingId)).size !== mappings.length || new Set(edges.map(item => item.edgeId)).size !== edges.length) return false;
  const roots = new Map<string, LocalRelocationEndpoint>();
  for (const item of [...operations, ...mappings, ...resources]) {
    for (const end of [item.source, item.target]) {
      const rootKey = `${end.libraryRootId}:${end.sourceRootId}`;
      const previous = roots.get(rootKey);
      if (previous && !sameRoot(previous, end)) return false;
      roots.set(rootKey, end);
    }
  }
  if (roots.size > LOCAL_RELOCATION_PLAN_BUDGET.sourceAndTargetRoots || operations.some(item => !mappings.some(map => sameRoot(item.source, map.source) && sameRoot(item.target, map.target)))
    || resources.some(item => !mappings.some(map => sameRoot(item.source, map.source) && sameRoot(item.target, map.target)))) return false;
  if (operations.some(item => item.resourceIds.some(id => !resourceIds.has(id))) || resources.some(item => item.operationIds.some(id => !operationIds.has(id)))) return false;
  if (operations.some(item => item.resourceIds.some(id => !resources.find(resource => resource.resourceId === id)!.operationIds.includes(item.operationId)))
    || resources.some(item => item.operationIds.some(id => !operations.find(operation => operation.operationId === id)!.resourceIds.includes(item.resourceId)))) return false;
  const assetIds = operations.flatMap(item => item.assetId === null ? [] : [item.assetId]);
  if (new Set(assetIds).size !== assetIds.length || operations.some(item => item.assetId !== null && !resources.some(resource => resource.role === 'AUDIO'
    && resource.operationIds.includes(item.operationId) && sameEndpoint(resource.source, item.source) && sameEndpoint(resource.target, item.target)))) return false;
  if (edges.some(item => !resourceIds.has(item.fromResourceId) || !resourceIds.has(item.toResourceId)) || retention.resourceIds.some(id => !resourceIds.has(id))) return false;
  if (resources.reduce((total, item) => total + BigInt(item.before.bytes), 0n) > BigInt(LOCAL_RELOCATION_PLAN_BUDGET.planFullSourceBytes)) return false;
  if (resources.reduce((total, item) => total + BigInt(item.after.bytes), 0n) > BigInt(LOCAL_RELOCATION_PLAN_BUDGET.planFullSourceBytes)) return false;
  if (closure.complete && resources.some(item => item.role === 'UNKNOWN_REFERENCE')) return false;
  if (edges.some(item => item.shared && (resources.find(resource => resource.resourceId === item.fromResourceId)!.sharedMemberIds.length === 0 || resources.find(resource => resource.resourceId === item.toResourceId)!.sharedMemberIds.length === 0))) return false;
  // 引用重写只发布目标新稿；原命名 CUE/清单仍属于需独立 cleanup 授权的保留源闭集。
  const retained = new Set(resources.filter(item => item.action === 'copy-retain' || item.action === 'retain' || item.action === 'rewrite-reference').map(item => item.resourceId));
  if (retained.size !== retention.resourceIds.length || retention.resourceIds.some(id => !retained.has(id))) return false;
  const plannedIntent = value.intent as LocalRelocationPlanIntent;
  if (plannedIntent.kind !== 'recovery' && operations.some(item => item.kind !== plannedIntent.kind)) return false;
  if (plannedIntent.kind === 'rename' || plannedIntent.kind === 'locate') {
    if (operations.length !== 1 || operations[0]!.assetId !== plannedIntent.target.assetId || operations[0]!.expectedFileRevision !== plannedIntent.target.expectedFileRevision
      || operations[0]!.expectedLocationRevision !== plannedIntent.target.expectedLocationRevision || operations[0]!.source.expectedRootRevision !== plannedIntent.target.expectedRootRevision) return false;
    if (plannedIntent.kind === 'rename' && operations[0]!.target.relative.split('/').at(-1) !== plannedIntent.newName) return false;
  }
  if (plannedIntent.kind === 'move') {
    if (operations.length !== plannedIntent.targets.length || plannedIntent.targets.some(target => !operations.some(item => item.assetId === target.assetId
      && item.expectedFileRevision === target.expectedFileRevision && item.expectedLocationRevision === target.expectedLocationRevision && item.source.expectedRootRevision === target.expectedRootRevision))) return false;
  }
  if (plannedIntent.kind === 'root-reassociate' && operations.some(item => item.source.libraryRootId !== plannedIntent.libraryRootId || item.source.expectedRootRevision !== plannedIntent.expectedRootRevision)) return false;
  if (plannedIntent.kind !== 'recovery' && plannedIntent.sourceDisposition !== retention.disposition) return false;
  return true;
}
export function localRelocationFrozenBodySnapshot(input: unknown): LocalRelocationFrozenBody {
  const value = localRelocationDataSnapshot(input, { maxBytes: LOCAL_RELOCATION_PLAN_BUDGET.completePlanBodyContextBytes });
  if (!bodyData(value)) return invalid();
  return value as unknown as LocalRelocationFrozenBody;
}
export function isLocalRelocationFrozenBody(input: unknown): input is LocalRelocationFrozenBody { try { localRelocationFrozenBodySnapshot(input); return true; } catch { return false; } }
function contextData(value: unknown): value is LocalRelocationFrozenContext {
  return record(value, ['version', 'domain', 'datasetId', 'planId', 'viewRevision', 'policyRevision', 'ownerEpoch', 'targetChoiceIds', 'rootObservationFingerprint', 'resourceObservationFingerprint', 'protectionFingerprint', 'reservationFingerprint', 'commandFingerprint'])
    && value.version === 1 && value.domain === LOCAL_RELOCATION_PLAN_DOMAIN && isLocalRelocationPlanDatasetId(value.datasetId) && [value.planId, value.ownerEpoch].every(isCollectionId)
    && [value.viewRevision, value.policyRevision].every(isLocalCatalogRevision) && ids(value.targetChoiceIds, 0, LOCAL_RELOCATION_PLAN_BUDGET.sourceAndTargetRoots)
    && [value.rootObservationFingerprint, value.resourceObservationFingerprint, value.protectionFingerprint, value.reservationFingerprint, value.commandFingerprint].every(isLocalRelocationPlanHash);
}
export function localRelocationFrozenContextSnapshot(input: unknown): LocalRelocationFrozenContext {
  const value = localRelocationDataSnapshot(input, { maxBytes: LOCAL_RELOCATION_PLAN_BUDGET.completePlanBodyContextBytes });
  if (!contextData(value)) return invalid();
  return value as unknown as LocalRelocationFrozenContext;
}
export function isLocalRelocationFrozenContext(input: unknown): input is LocalRelocationFrozenContext { try { localRelocationFrozenContextSnapshot(input); return true; } catch { return false; } }
export function localRelocationFrozenPlanSnapshot(body: unknown, context: unknown): Readonly<{ body: LocalRelocationFrozenBody; context: LocalRelocationFrozenContext }> {
  const captured = localRelocationDataSnapshot({ body, context }, { maxBytes: LOCAL_RELOCATION_PLAN_BUDGET.completePlanBodyContextBytes });
  if (!record(captured, ['body', 'context']) || !bodyData(captured.body) || !contextData(captured.context)
    || captured.body.guards.reservationFingerprint !== captured.context.reservationFingerprint || !localRelocationCompletePlanWithinBudget(captured.body, captured.context)) return invalid();
  return captured as unknown as Readonly<{ body: LocalRelocationFrozenBody; context: LocalRelocationFrozenContext }>;
}
function grant(value: unknown): value is LocalRelocationMainGrant {
  return record(value, ['domain', 'action', 'challengeId', 'ownerEpoch', 'nonce', 'authorityId', 'signature']) && value.domain === LOCAL_RELOCATION_PLAN_DOMAIN && values(value.action, ['execute', 'cleanup'] as const)
    && [value.challengeId, value.ownerEpoch, value.authorityId].every(isCollectionId) && [value.nonce, value.signature].every(isLocalRelocationPlanHash);
}
function payloadData(command: LocalRelocationMainCommand, value: unknown): boolean {
  if (!value || typeof value !== 'object' || !isLocalRelocationPlanDatasetId((value as Data).datasetId)) return false;
  const data = value as Data;
  if (command === 'localRelocationMain.captureTarget') return record(data, ['datasetId', 'commandId', 'kind', 'absolutePath']) && isCollectionId(data.commandId) && (data.kind === 'directory' || data.kind === 'file') && isLocalRelocationMainAbsolutePath(data.absolutePath);
  if (command === 'localRelocationMain.challenge' || command === 'localRelocationMain.executeGranted') {
    return record(data, command === 'localRelocationMain.challenge' ? ['datasetId', 'confirm'] : ['datasetId', 'confirm', 'grant'])
      && isLocalRelocationPlanCommandPayload('localRelocationPlan.confirm', data.confirm) && data.confirm.datasetId === data.datasetId
      && (command === 'localRelocationMain.challenge' || grant(data.grant) && data.grant.action === 'execute');
  }
  return record(data, command === 'localRelocationMain.challengeCleanup' ? ['datasetId', 'cleanup'] : ['datasetId', 'cleanup', 'grant'])
    && isLocalRelocationPlanCommandPayload('localRelocationPlan.cleanup', data.cleanup) && data.cleanup.datasetId === data.datasetId
    && (command === 'localRelocationMain.challengeCleanup' || grant(data.grant) && data.grant.action === 'cleanup');
}
export function localRelocationMainCommandPayloadSnapshot<C extends LocalRelocationMainCommand>(command: C, input: unknown): LocalRelocationMainCommandPayloads[C] {
  const value = localRelocationDataSnapshot(input);
  if (!isLocalRelocationMainCommand(command) || !payloadData(command, value)) return invalid();
  return value as LocalRelocationMainCommandPayloads[C];
}
export function isLocalRelocationMainCommandPayload<C extends LocalRelocationMainCommand>(command: C, input: unknown): input is LocalRelocationMainCommandPayloads[C] {
  try { localRelocationMainCommandPayloadSnapshot(command, input); return true; } catch { return false; }
}
function challenge(value: unknown, action: 'execute' | 'cleanup'): value is LocalRelocationMainChallenge {
  if (!record(value, ['datasetId', 'commandId', 'planId', 'expectedViewRevision', 'domain', 'action', 'planHash', 'contextFingerprint', 'policyRevision', 'requestFingerprint', 'verifiedTargetFingerprint', 'sourceResourceIds', 'expiresAt', 'grant'])
    || !isLocalRelocationPlanDatasetId(value.datasetId) || ![value.commandId, value.planId].every(isCollectionId) || ![value.expectedViewRevision, value.policyRevision].every(isLocalCatalogRevision)
    || value.domain !== LOCAL_RELOCATION_PLAN_DOMAIN || value.action !== action || ![value.planHash, value.contextFingerprint, value.requestFingerprint].every(isLocalRelocationPlanHash)
    || !ids(value.sourceResourceIds, 0, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || !isLocalRelocationPlanDate(value.expiresAt) || !grant(value.grant) || value.grant.action !== action) return false;
  return action === 'execute' ? value.verifiedTargetFingerprint === null && value.sourceResourceIds.length === 0 : isLocalRelocationPlanHash(value.verifiedTargetFingerprint) && value.sourceResourceIds.length > 0;
}
function resultData(command: LocalRelocationMainCommand, value: unknown): boolean {
  switch (command) {
    case 'localRelocationMain.captureTarget': return value !== null && isLocalRelocationPlanCommandResult('localRelocationPlan.chooseTarget', value);
    case 'localRelocationMain.challenge': return challenge(value, 'execute');
    case 'localRelocationMain.challengeCleanup': return challenge(value, 'cleanup');
    case 'localRelocationMain.executeGranted': return isLocalRelocationPlanCommandResult('localRelocationPlan.confirm', value);
    case 'localRelocationMain.cleanupGranted': return isLocalRelocationPlanCommandResult('localRelocationPlan.cleanup', value);
  }
  return false;
}
export function localRelocationMainCommandResultSnapshot<C extends LocalRelocationMainCommand>(command: C, input: unknown): LocalRelocationMainCommandResults[C] {
  const value = localRelocationDataSnapshot(input);
  if (!isLocalRelocationMainCommand(command) || !resultData(command, value)) return invalid();
  return value as LocalRelocationMainCommandResults[C];
}
export function isLocalRelocationMainCommandResult<C extends LocalRelocationMainCommand>(command: C, input: unknown): input is LocalRelocationMainCommandResults[C] {
  try { localRelocationMainCommandResultSnapshot(command, input); return true; } catch { return false; }
}
export function localRelocationMainRequestSnapshot(input: unknown): LocalRelocationMainRequest {
  const value = localRelocationDataSnapshot(input);
  if (!record(value, ['version', 'type', 'requestId', 'sequence', 'command', 'payload']) || value.version !== 1 || value.type !== 'relocation-main-request' || !isCollectionId(value.requestId)
    || !sequence(value.sequence) || !isLocalRelocationMainCommand(value.command) || !payloadData(value.command, value.payload)) return invalid();
  return value as unknown as LocalRelocationMainRequest;
}
export function isLocalRelocationMainRequest(input: unknown): input is LocalRelocationMainRequest { try { localRelocationMainRequestSnapshot(input); return true; } catch { return false; } }
const errorCodes = [
  'OUTBOX_SCOPE_MISMATCH', 'INVALID_IPC_REQUEST', 'UNSUPPORTED_IPC_VERSION', 'UNKNOWN_IPC_COMMAND', 'INVALID_IPC_RESPONSE',
  'TIMEOUT', 'CANCELLED', 'NOT_READY', 'ATTEMPT_NOT_ACCEPTED', 'INVENTORY_CONFLICT', 'INVENTORY_UNAVAILABLE', 'AUTH_REQUIRED', 'AUTH_EXPIRED',
  'ACCOUNT_PROFILE_UNAVAILABLE', 'DAILY_RECOMMENDATIONS_UNAVAILABLE', 'ROON_CORE_NOT_CONNECTED', 'ROON_TIMEOUT', 'ROON_LIBRARY_UNAVAILABLE',
  'ROON_LIBRARY_REQUEST_FAILED', 'ROON_ZONE_NOT_SELECTED', 'ROON_IMAGE_UNAVAILABLE', 'ROON_IMAGE_DECODE_FAILED', 'ROON_ALBUM_HIERARCHY_INVALID',
  'ROON_TRACK_ACTION_UNAVAILABLE', 'INTERNAL_ERROR',
] as const;
function failure(value: unknown, requestId: string): value is IpcFailure {
  if (!record(value, ['version', 'id', 'ok', 'error']) || value.version !== 1 || value.id !== requestId || value.ok !== false
    || !record(value.error, ['code', 'message'], ['diagnosticId']) || !values(value.error.code, errorCodes)) return false;
  const safeText = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && text.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(text) && !/\b(?:bearer|cookie|token|session[_-]?(?:id|handle))\s*[:=]/iu.test(text)
    && !/(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)(?:[\/\\]|~[\/\\]|[a-z]:[\\/]))/iu.test(text);
  return safeText(value.error.message) && (!Object.hasOwn(value.error, 'diagnosticId') || typeof value.error.diagnosticId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.error.diagnosticId));
}
export function localRelocationMainResponseSnapshot(input: unknown, command: LocalRelocationMainCommand): LocalRelocationMainResponse {
  const value = localRelocationDataSnapshot(input);
  if (!isLocalRelocationMainCommand(command) || !record(value, ['version', 'type', 'requestId', 'sequence', 'ok'], ['result', 'failure']) || value.version !== 1 || value.type !== 'relocation-main-response'
    || !isCollectionId(value.requestId) || !sequence(value.sequence)) return invalid();
  if (value.ok === true && record(value, ['version', 'type', 'requestId', 'sequence', 'ok', 'result']) && resultData(command, value.result)) return value as unknown as LocalRelocationMainResponse;
  if (value.ok === false && record(value, ['version', 'type', 'requestId', 'sequence', 'ok', 'failure']) && failure(value.failure, value.requestId)) return value as unknown as LocalRelocationMainResponse;
  return invalid();
}
export function isLocalRelocationMainResponse(input: unknown, command: LocalRelocationMainCommand): input is LocalRelocationMainResponse {
  try { localRelocationMainResponseSnapshot(input, command); return true; } catch { return false; }
}
