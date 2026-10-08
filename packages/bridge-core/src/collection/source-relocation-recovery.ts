import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, link, unlink, rename, statfs, opendir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import type { RootCapability, PublicationSource } from '../recording/source-files.js';
import { assertRetainedPhysicalWriteClaims, closePhysicalWriteClaimDescriptors, transferPhysicalWriteClaims, type PhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import { assertSourceNamespaceHeld, delegateSourceNamespaceRecovery, retainSourceNamespaceWrite, resolveSourceNamespaceOrigin,
  resolveSourceNamespaceRecovery, type SourceNamespaceWriteToken, type SourceNamespaceRecoveryToken, type SourceNamespaceHeldScope,
  type SourceNamespaceHeldObservation } from '../stream/source-namespace-claims.js';
import { observeSourceFileAttributes, sameSourceFileAttributes } from './source-writes-publisher.js';
import { assertRelocationRootIdentity, observeRelocationRootIdentity } from './source-relocation-root-identity.js';
import { captureRelocationPath, observeRelocationFile, verifyRelocationPath, relocationSignature, checkRelocationIo,
  createRelocationReadAccess, revokeRelocationReadAccess, type RelocationFileObservation, type RelocationPathObservation,
  type RelocationReadAccess, type RelocationIoOptions } from './source-relocation-verify.js';
import { RelocationPublicationRecoveryRequired, observeRelocationMaterialUsage, type RelocationPublishedResource } from './source-relocation-publisher.js';
import { relocationHash, relocationCanonical, relocationFail, relocationRecoveryFingerprint, relocationRecoveryChoiceId, type RelocationRecoveryOrigin,
  type RelocationStoredPlan, type RelocationCatalogSnapshot, type RelocationCapturedResource, type RelocationStoredOperation,
  type RelocationPublisherFact } from './local-relocation-journal.js';

type Namespace = { token: SourceNamespaceWriteToken | SourceNamespaceRecoveryToken; scope: SourceNamespaceHeldScope };
declare const groupBrand: unique symbol;
export interface RelocationRecoveryGroup { readonly [groupBrand]: true }
interface Group { family: readonly RelocationStoredPlan[]; claims: PhysicalWriteClaims; namespace: Namespace; ancestors: Namespace[];
  handles: FileHandle[]; active: boolean; preparing: boolean; currentPlanId: string }
const groups = new WeakMap<object, Group>();
const same = (a: unknown, b: unknown): boolean => relocationCanonical(a) === relocationCanonical(b);
const physical = (s: BigIntStats) => ({ dev: String(s.dev), ino: String(s.ino) });
const exists = async (absolute: string): Promise<BigIntStats | null> => {
  try { return await lstat(absolute, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
const matches = (value: RelocationFileObservation, expected: { sha256: string; bytes: string }): boolean => value.sha256 === expected.sha256 && String(value.bytes) === expected.bytes;
const inode = (a: RelocationFileObservation, b: RelocationFileObservation): boolean => same(a.physical, b.physical) && a.birthtimeNs === b.birthtimeNs;
function group(cap: RelocationRecoveryGroup): Group {
  const value = groups.get(cap); if (!value?.active) return relocationFail('RECOVERY_REQUIRED');
  assertRetainedPhysicalWriteClaims(value.claims, []); assertSourceNamespaceHeld(value.namespace.token, value.namespace.scope); return value;
}

/** 同一真保护组，冷重开只重建journal认证的委托链，不重发原命令或执行文件操作。 */
export function adoptRelocationRecoveryGroup(family: readonly RelocationStoredPlan[], held: RelocationPublicationRecoveryRequired): RelocationRecoveryGroup {
  const anchor = family.findIndex(value => value.plan.planId === held.namespace?.scope.originBinding.originPlanId);
  if (!family.length || !held.claims || !held.namespace || !family.every(value => value.ready) || held.namespace.scope.datasetId !== family[0]!.plan.datasetId
    || anchor < 0 || held.namespace.scope.originBinding.planHash !== family[anchor]!.plan.planHash
    || held.namespace.scope.originBinding.contextFingerprint !== family[anchor]!.plan.contextFingerprint
    || family.slice(0, anchor).some(value => value.resources.some(resource => !value.resolvedResources.has(resource.frozen.resourceId)))) return relocationFail('RECOVERY_REQUIRED');
  assertRetainedPhysicalWriteClaims(held.claims, []); assertSourceNamespaceHeld(held.namespace.token, held.namespace.scope);
  const ancestors: Namespace[] = [], state: Group = { family, claims: held.claims, namespace: held.namespace, ancestors, handles: [...held.handles], active: true, preparing: false,
    currentPlanId: held.namespace.scope.planId };
  const start = family.findIndex(value => value.plan.planId === state.currentPlanId); if (start < 0) return relocationFail('RECOVERY_REQUIRED');
  for (const member of family.slice(start + 1)) {
    const origin = member.recoveryOrigin; if (!origin || origin.originPlanId !== state.currentPlanId) return relocationFail('RECOVERY_REQUIRED');
    const old = state.namespace, operations = old.scope.operations.map(value => {
      const mapping = origin.operationMappings.find(mapping => mapping.originOperationId === value.operationId); if (!mapping) return relocationFail('RECOVERY_REQUIRED');
      return { operationId: mapping.operationId, originOperationId: value.operationId, name: value.name };
    });
    const token = delegateSourceNamespaceRecovery(old.token, { datasetId: old.scope.datasetId, originPlanId: old.scope.planId, recoveryPlanId: member.plan.planId,
      originBinding: old.scope.originBinding, operations }); retainSourceNamespaceWrite(token);
    ancestors.push(old); state.namespace = { token, scope: { datasetId: old.scope.datasetId, planId: member.plan.planId, originBinding: old.scope.originBinding,
      operations: operations.map(({ originOperationId: _origin, ...value }) => value) } }; state.currentPlanId = member.plan.planId;
  }
  const cap = Object.freeze({}) as RelocationRecoveryGroup; groups.set(cap, state); return cap;
}
export function updateRelocationRecoveryFamily(cap: RelocationRecoveryGroup, family: readonly RelocationStoredPlan[]): void {
  const state = group(cap); if (family.at(-1)?.plan.planId !== state.currentPlanId || family[0]?.plan.planId !== state.family[0]?.plan.planId) return relocationFail('RECOVERY_REQUIRED'); state.family = family;
}
export function relocationRecoveryGroupPlanId(cap: RelocationRecoveryGroup): string { return group(cap).currentPlanId; }
export function retainedRelocationRecovery(cap: RelocationRecoveryGroup, cause?: unknown): RelocationPublicationRecoveryRequired {
  const state = group(cap); state.claims.retain(); retainSourceNamespaceWrite(state.namespace.token);
  return new RelocationPublicationRecoveryRequired(state.claims, state.namespace, [], state.handles, 'RECOVERY_REQUIRED', cause);
}

interface Named { path: RelocationPathObservation; handle: FileHandle; observation: RelocationFileObservation }
interface RecoveryFile { original: RelocationCapturedResource; capture: RelocationCapturedResource; material: Named; target: RelocationPathObservation;
  targetFile: Named | null; slots: RelocationPathObservation[]; evacuation: Named | null; retained: boolean }
declare const preparedBrand: unique symbol;
export interface PreparedRelocationRecovery { readonly [preparedBrand]: true; readonly fingerprint: string }
interface Prepared { group: RelocationRecoveryGroup; planId: string; family: readonly RelocationStoredPlan[]; origin: RelocationRecoveryOrigin;
  files: RecoveryFile[]; snapshots: RelocationCatalogSnapshot[]; directories: Map<string, FileHandle>; paths: RelocationPathObservation[]; observations: Named[]; inventories: { directory: string; entries: unknown[] }[]; active: boolean; consumed: boolean }
const prepared = new WeakMap<object, Prepared>();
export interface RelocationRecoveryPreparation {
  access: PreparedRelocationRecovery; origin: RelocationRecoveryOrigin; resources: RelocationCapturedResource[]; operations: RelocationStoredOperation[];
  mappings: dto.LocalRelocationRootMapping[]; edges: dto.LocalRelocationReferenceEdge[]; rootRelink: { before: dto.LibraryRoot; after: dto.LibraryRoot } | null;
  reservationFingerprint: string;
  inventories: { directory: string; entries: unknown[] }[];
  materialObservations: { root: RootCapability; relative: string; observation: RelocationFileObservation }[];
  pathObservations: readonly RelocationPathObservation[];
}
async function directoryInventory(directory: string): Promise<unknown[]> {
  const result: { name: string; physical: { dev: string; ino: string }; birthtimeNs: string; bytes: string; mode: string; signature: string }[] = [], handle = await opendir(directory);
  for await (const entry of handle) {
    if (result.length >= dto.LOCAL_RELOCATION_PLAN_BUDGET.closedResources) return relocationFail('OVER_BUDGET');
    const info = await lstat(path.join(directory, entry.name), { bigint: true }); if (info.isSymbolicLink()) return relocationFail('SYMLINK');
    result.push({ name: entry.name, physical: physical(info), birthtimeNs: String(info.birthtimeNs), bytes: String(info.size), mode: String(info.mode), signature: relocationSignature(info) });
  }
  return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function withRelocationRecoveryProtection<T>(cap: PreparedRelocationRecovery,
  consume: (claims: PhysicalWriteClaims, sources: readonly PublicationSource[], namespace: (source: PublicationSource) => SourceNamespaceHeldObservation | undefined) => Promise<T>): Promise<T> {
  const value = prepared.get(cap); if (!value?.active || value.consumed) return relocationFail('RECOVERY_REQUIRED');
  const state = group(value.group);
  return consume(state.claims, value.files.map(file => ({ root: file.material.path.root, relative: file.material.path.relative, expectedSignature: file.material.observation.signature })), source => {
    const match = state.namespace.scope.operations.find(value => value.name.absolute === path.join(source.root.path, source.relative));
    return match ? { token: state.namespace.token, datasetId: state.namespace.scope.datasetId, planId: state.namespace.scope.planId,
      originBinding: state.namespace.scope.originBinding, operationId: match.operationId } : undefined;
  });
}
export async function invalidateRelocationRecoveryPreparation(cap: PreparedRelocationRecovery): Promise<void> {
  const value = prepared.get(cap); if (!value?.active || value.consumed) return relocationFail('BUSY'); value.active = false;
  const state = group(value.group); await closePhysicalWriteClaimDescriptors(state.claims); state.claims.retain();
}

/** Choice是journal对账入口，不冒称目标已验证；完整FD/根/属性/空间只在新preview做。 */
export function relocationRecoveryChoices(family: readonly RelocationStoredPlan[]): dto.LocalRelocationPlanRecoveryChoice[] {
  const origin = family.at(-1); if (!origin?.ready || !origin.resources.length || origin.resources.every(value => origin.resolvedResources.has(value.frozen.resourceId))) return [];
  const fingerprint = relocationRecoveryFingerprint(family), committed = family.some(value => value.events.some(event => event.kind === 'location-facts'));
  const actions: dto.LocalRelocationPlanRecoveryChoice['action'][] = committed ? ['reconcile', 'rollback', 'keep-target'] : ['keep-target', 'rollback'];
  return actions.map(action => ({ choiceId: relocationRecoveryChoiceId(origin.plan.planId, fingerprint, action), originPlanId: origin.plan.planId,
    expectedOriginViewRevision: origin.plan.viewRevision, recoveryFingerprint: fingerprint, action,
    label: action === 'reconcile' ? '核验已登记位置并结束未知状态' : action === 'rollback' ? '恢复原位置并重新登记' : '保留已核验目标并完成登记',
    resourceIds: origin.resources.map(value => value.frozen.resourceId) }));
}
function catalogDirection(family: readonly RelocationStoredPlan[], snapshots: readonly RelocationCatalogSnapshot[]): 'before' | 'after' {
  const root = family[0]!;
  if (snapshots.length !== root.operations.length) return relocationFail('CLOSURE_INCOMPLETE');
  const directions = root.operations.map(original => {
    const current = snapshots.find(value => value.asset.id === original.source?.asset.id); if (!current || !original.source) return relocationFail('REVISION_CONFLICT');
    if (!same(current.tracks, original.source.tracks) || current.catalogSha256 !== original.source.catalogSha256 || current.asset.fileRevision !== original.source.asset.fileRevision) return relocationFail('REVISION_CONFLICT');
    const latest = family.flatMap(value => value.events).filter((event): event is Extract<import('./local-relocation-journal.js').RelocationEvent, { kind: 'location-facts' }> => event.kind === 'location-facts' && event.fact.afterAsset.id === current.asset.id).at(-1);
    if (latest) {
      if (!same(latest.fact.afterAsset, current.asset) || current.relative !== latest.fact.target.relative) return relocationFail('REVISION_CONFLICT');
    } else if (!same(current.asset, original.source.asset) || current.relative !== original.source.relative || !same(current.libraryRoot, original.source.libraryRoot)) return relocationFail('REVISION_CONFLICT');
    const atBefore = current.asset.sourceRootId === original.operation.source.sourceRootId && current.relative === original.operation.source.relative;
    const atAfter = current.asset.sourceRootId === original.operation.target.sourceRootId && current.relative === original.operation.target.relative;
    if (!atBefore && !atAfter) return relocationFail('REVISION_CONFLICT'); return atAfter ? 'after' : 'before';
  });
  if (!directions.every(value => value === directions[0])) return relocationFail('REVISION_CONFLICT'); return directions[0]!;
}
async function privateRoot(absolute: string): Promise<RootCapability> {
  const info = await lstat(absolute, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute || (info.mode & 0o7777n) !== 0o700n
    || typeof process.getuid !== 'function' || info.uid !== BigInt(process.getuid())) return relocationFail('UNQUALIFIED');
  return { id: randomUUID(), path: absolute, ...physical(info), authorized: true, label: '本域恢复保全材料' };
}
async function keep(state: Group, handle: FileHandle): Promise<void> {
  if (!state.handles.includes(handle)) state.handles.push(handle);
  // 整组transfer保留旧guard与已quiet条目；新的真实FileHandle不能用旧数字FD冒充。
  state.claims = await transferPhysicalWriteClaims(state.claims, [physical(await handle.stat({ bigint: true }))], state.handles.filter(value => value.fd !== -1));
}
async function named(state: Group, observed: RelocationPathObservation, options: RelocationIoOptions, alias = false): Promise<Named | null> {
  await verifyRelocationPath(observed);
  const info = await exists(observed.absolute); if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n && !(alias && info.nlink === 2n)) return relocationFail('UNSUPPORTED_SOURCE');
  const handle = await open(observed.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await keep(state, handle); } catch (error) { throw new RelocationPublicationRecoveryRequired(state.claims, state.namespace, [], state.handles, 'RECOVERY_REQUIRED', error); }
  const observation = await observeRelocationFile(handle, { ...options, expectedLinks: info.nlink });
  await verifyRelocationPath(observed);
  const after = await lstat(observed.absolute, { bigint: true }); if (after.isSymbolicLink() || relocationSignature(after) !== observation.signature || String(after.birthtimeNs) !== observation.birthtimeNs) return relocationFail('SOURCE_CHANGED');
  return { path: observed, handle, observation };
}
function authenticatedOwnership(family: readonly RelocationStoredPlan[], original: RelocationCapturedResource, value: RelocationFileObservation): boolean {
  if (original.frozen.action === 'move' && inode(original.sourceObservation, value)) return true;
  return family.some(plan => plan.events.some(event => event.kind === 'phase' && event.fact.resourceId === original.frozen.resourceId && event.fact.targetObservation
    && inode(event.fact.targetObservation, value) && event.fact.targetObservation.sha256 === value.sha256 && event.fact.targetObservation.bytes === value.bytes));
}
function authenticatedEndpointOwnership(family: readonly RelocationStoredPlan[], original: RelocationCapturedResource, side: 'source' | 'target', value: RelocationFileObservation): boolean {
  if (side === 'source' && !original.sourceAbsent && inode(original.sourceObservation, value)) return true;
  const endpoint = original.frozen[side];
  return family.some(plan => plan.resources.some(resource => resource.frozen.resourceId === original.frozen.resourceId && resource.frozen.target.sourceRootId === endpoint.sourceRootId
    && resource.frozen.target.relative === endpoint.relative) && plan.events.some(event => event.kind === 'phase' && event.fact.resourceId === original.frozen.resourceId
      && event.fact.targetObservation && inode(event.fact.targetObservation, value) && event.fact.targetObservation.sha256 === value.sha256 && event.fact.targetObservation.bytes === value.bytes));
}

export async function prepareRelocationRecovery(input: { family: readonly RelocationStoredPlan[]; group: RelocationRecoveryGroup; planId: string;
  intent: Extract<dto.LocalRelocationPlanIntent, { kind: 'recovery' }>; snapshots: RelocationCatalogSnapshot[]; retainedSourceBytes: number; signal: AbortSignal; assertCurrent(): void }): Promise<RelocationRecoveryPreparation> {
  const state = group(input.group), origin = input.family.at(-1)!, root = input.family[0]!, choices = relocationRecoveryChoices(input.family);
  const choice = choices.find(value => value.choiceId === input.intent.choiceId);
  if (!choice || choice.originPlanId !== input.intent.originPlanId || choice.expectedOriginViewRevision !== input.intent.expectedOriginViewRevision || choice.recoveryFingerprint !== input.intent.recoveryFingerprint
    || state.currentPlanId !== origin.plan.planId || state.preparing) return relocationFail('STALE_VIEW');
  state.preparing = true;
  const io = { signal: input.signal, deadlineAt: Date.now() + dto.LOCAL_RELOCATION_PLAN_BUDGET.runtimeDeadlineMs }, directories = new Map<string, FileHandle>(), observations: Named[] = [];
  const files: RecoveryFile[] = [], paths: RelocationPathObservation[] = [], operations: RelocationStoredOperation[] = [], resources: RelocationCapturedResource[] = [], mappings: dto.LocalRelocationRootMapping[] = [];
  const mapping = origin.operations.map(value => ({ originOperationId: value.operation.operationId, operationId: randomUUID() }));
  const recoveryOrigin: RelocationRecoveryOrigin = { originPlanId: origin.plan.planId, originPlanHash: origin.plan.planHash, originViewRevision: origin.plan.viewRevision,
    originJournalSequence: origin.plan.journalSequence, familyRootPlanId: root.plan.planId, action: choice.action, recoveryFingerprint: choice.recoveryFingerprint,
    destination: choice.action === 'rollback' ? 'source' : 'target', operationMappings: mapping };
  let rootRelink: RelocationRecoveryPreparation['rootRelink'] = null;
  try {
    const direction = catalogDirection(input.family, input.snapshots);
    if (choice.action === 'reconcile' && direction !== 'after' && !input.family.some(value => value.events.some(event => event.kind === 'location-facts'))) return relocationFail('RECOVERY_REQUIRED');
    const rollback = choice.action === 'rollback' || choice.action === 'reconcile' && direction === 'before', desiredSide = rollback ? 'source' : 'target';
    const unregisteredRollback = choice.action === 'rollback' && direction === 'before' && !input.family.some(value => value.events.some(event => event.kind === 'location-facts'));
    recoveryOrigin.destination = desiredSide;
    if (root.plan.intent.kind === 'root-reassociate') {
      const before = input.snapshots[0]!.libraryRoot, destination = root.operations[0]!.operation[desiredSide];
      if (before.sourceRootId !== destination.sourceRootId) {
        if (choice.action === 'reconcile') return relocationFail('REVISION_CONFLICT');
        rootRelink = { before, after: { ...before, sourceRootId: destination.sourceRootId, revision: String(BigInt(before.revision) + 1n) } };
      }
    }
    for (let index = 0; index < root.operations.length; index++) {
      const original = root.operations[index]!, current = input.snapshots.find(value => value.asset.id === original.source!.asset.id)!;
      const source: dto.LocalRelocationEndpoint = { libraryRootId: current.libraryRoot.id, sourceRootId: current.asset.sourceRootId, expectedRootRevision: current.libraryRoot.revision, relative: current.relative };
      const target = { ...original.operation[desiredSide], expectedRootRevision: rootRelink?.after.revision ?? (original.operation[desiredSide].libraryRootId === current.libraryRoot.id ? current.libraryRoot.revision : original.operation[desiredSide].expectedRootRevision) };
      const operationId = mapping[index]!.operationId, resourceIds = [...original.operation.resourceIds];
      const operation: dto.LocalRelocationFrozenOperation = { ...original.operation, operationId, kind: 'recovery', source, target,
        expectedFileRevision: current.asset.fileRevision, expectedLocationRevision: current.asset.locationRevision, resourceIds };
      operations.push({ operation, source: current, item: { ...original.item, operationId, sourceLabel: path.posix.basename(source.relative), targetLabel: path.posix.basename(target.relative),
        expectedFileRevision: current.asset.fileRevision, expectedLocationRevision: current.asset.locationRevision, expectedRootRevision: current.libraryRoot.revision, state: 'pending', phase: 'PLANNED', resourceIds, issue: null } });
    }
    for (const original of root.resources) {
      input.assertCurrent(); checkRelocationIo(io);
      await assertRelocationRootIdentity(original.sourceRoot, original.sourceIdentity, io); await assertRelocationRootIdentity(original.targetRoot, original.targetIdentity, io);
      const operationIds = original.frozen.operationIds.map(old => {
        const index = root.operations.findIndex(value => value.operation.operationId === old); if (index < 0) return relocationFail('CLOSURE_INCOMPLETE'); return operations[index]!.operation.operationId;
      });
      const owning = operations.find(value => operationIds.includes(value.operation.operationId))!.operation;
      const desired = rollback ? original.frozen.before : original.frozen.after;
      const sourceRoot = owning.source.sourceRootId === original.sourceRoot.id ? original.sourceRoot : original.targetRoot;
      const targetRoot = rollback ? original.sourceRoot : original.targetRoot;
      const sourceEndpoint = { ...owning.source, relative: direction === 'after' ? original.frozen.target.relative : original.frozen.source.relative };
      const targetEndpoint = { ...owning.target, sourceRootId: targetRoot.id, relative: rollback ? original.frozen.source.relative : original.frozen.target.relative };
      const sourcePath = await captureRelocationPath(sourceRoot, sourceEndpoint.relative), targetPath = await captureRelocationPath(targetRoot, targetEndpoint.relative);
      const candidates: RelocationPathObservation[] = [sourcePath, targetPath], slots: RelocationPathObservation[] = [];
      for (const [cap, relative] of [[original.sourceRoot, original.frozen.source.relative], [original.targetRoot, original.frozen.target.relative]] as const)
        if (!candidates.some(value => value.absolute === path.join(cap.path, relative))) candidates.push(await captureRelocationPath(cap, relative));
      if (original.storage) for (const [root, relative] of [[original.storage.targetPrivateRoot, original.storage.stage], [original.storage.sourcePrivateRoot, original.storage.quarantine],
        [original.storage.sourcePrivateRoot, original.storage.backup]] as const) {
        const value = await captureRelocationPath(root, relative); if (!state.namespace.scope.operations.some(operation => operation.name.absolute === value.absolute)) return relocationFail('RECOVERY_REQUIRED');
        slots.push(value); if (!candidates.some(candidate => candidate.absolute === value.absolute)) candidates.push(value);
      }
      for (const member of input.family) for (const event of member.events) if (event.kind === 'phase' && event.fact.resourceId === original.frozen.resourceId) {
        for (const absolute of [event.fact.stage, event.fact.quarantine, event.fact.retained]) if (absolute && !candidates.some(value => value.absolute === absolute)) {
          if (!state.namespace.scope.operations.some(value => value.name.absolute === absolute) || !input.family.some(value => value.plan.planId === path.basename(path.dirname(absolute)))) return relocationFail('RECOVERY_REQUIRED');
          const cap = await privateRoot(path.dirname(absolute)), value = await captureRelocationPath(cap, path.basename(absolute)); slots.push(value); candidates.push(value);
        }
      }
      for (const observed of candidates) for (const ancestor of observed.ancestors) if (!directories.has(ancestor.absolute)) {
        const handle = await open(ancestor.absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await keep(state, handle); directories.set(ancestor.absolute, handle);
      }
      for (const observed of candidates) if (!paths.some(value => value.absolute === observed.absolute)) paths.push(observed);
      const values: Named[] = [];
      for (const candidate of candidates) { const value = await named(state, candidate, io, true); if (value) { values.push(value); observations.push(value); } }
      const targetFile = values.find(value => value.path.absolute === targetPath.absolute) ?? null;
      if (targetFile && !matches(targetFile.observation, desired)) return relocationFail('TARGET_CHANGED');
      if (choice.action === 'reconcile') {
        if (!targetFile || targetFile.observation.links !== '1') return relocationFail('TARGET_CHANGED');
        const registered = input.family.flatMap(value => value.events).filter(event => event.kind === 'location-facts' && event.fact.resourceId === original.frozen.resourceId).at(-1);
        const prior = input.family.flatMap(value => value.events).filter(event => event.kind === 'phase' && event.fact.resourceId === original.frozen.resourceId && event.fact.targetObservation !== null).at(-1);
        const observation = registered?.kind === 'location-facts' ? registered.fact.targetObservation : prior?.kind === 'phase' ? prior.fact.targetObservation : null;
        if (!observation || !same(targetFile.observation, observation)) return relocationFail('TARGET_CHANGED');
      }
      const aliases: { root: RootCapability; relative: string }[] = [];
      if (targetFile?.observation.links === '2') {
        const twins = values.filter(value => value.path.absolute !== targetPath.absolute && inode(value.observation, targetFile.observation));
        if (twins.length !== 1 || twins[0]!.observation.links !== '2' || !slots.some(value => value.absolute === twins[0]!.path.absolute)
          || !authenticatedOwnership(input.family, original, targetFile.observation)) return relocationFail('UNKNOWN_REFERENCE');
        aliases.push({ root: twins[0]!.path.root, relative: twins[0]!.path.relative });
      }
      const sourceNamed = values.find(value => value.path.absolute === sourcePath.absolute && value.observation.links === '1');
      const trusted = (value: Named) => value.observation.links === '1' && (matches(value.observation, original.frozen.before) || matches(value.observation, original.frozen.after));
      const material = sourceNamed && trusted(sourceNamed) ? sourceNamed : values.find(trusted);
      if (!material) return relocationFail('VERIFY_FAILED');
      let rewriteMaterial: RelocationCapturedResource['rewriteMaterial'] = null;
      if (!matches(material.observation, desired)) {
        if (!['CUE', 'MANIFEST'].includes(original.frozen.role)) return relocationFail('VERIFY_FAILED');
        const desiredNamed = values.find(value => matches(value.observation, desired) && value.observation.links === '1');
        if (desiredNamed) rewriteMaterial = { path: desiredNamed.path.absolute, sha256: desired.sha256, bytes: Number(desired.bytes) };
        else if (original.rewriteMaterial && !rollback) {
          const cap = await privateRoot(path.dirname(original.rewriteMaterial.path)), observed = await captureRelocationPath(cap, path.basename(original.rewriteMaterial.path));
          const value = await named(state, observed, io); if (!value || !matches(value.observation, desired)) return relocationFail('VERIFY_FAILED');
          observations.push(value); rewriteMaterial = { ...original.rewriteMaterial };
        } else return relocationFail('VERIFY_FAILED');
      }
      const action = rewriteMaterial ? 'rewrite-reference' as const : targetFile ? 'retain' as const : 'copy-retain' as const;
      const retainedSide = desiredSide === 'target' ? 'source' : 'target', retainedRoot = retainedSide === 'source' ? original.sourceRoot : original.targetRoot;
      const retainedEndpoint = { ...original.frozen[retainedSide] }, retainedBytes = retainedSide === 'source' ? original.frozen.before : original.frozen.after;
      const retainedFile = values.find(value => value.path.absolute === path.join(retainedRoot.path, retainedEndpoint.relative) && value.path.absolute !== targetPath.absolute
        && (!targetFile || !inode(value.observation, targetFile.observation)));
      const retained = !!retainedFile && !unregisteredRollback;
      // 未登记回滚的已安装对象沿下方evacuation认证并保全；它不产生保留源marker或具体cleanup能力。
      if (retainedFile && !unregisteredRollback && (retainedFile.observation.links !== '1' || !matches(retainedFile.observation, retainedBytes)
        || !authenticatedEndpointOwnership(input.family, original, retainedSide, retainedFile.observation)
        || !sameSourceFileAttributes(await observeSourceFileAttributes(retainedFile.path.absolute, retainedFile.handle), original.attributes))) return relocationFail('SOURCE_CHANGED');
      const capture: RelocationCapturedResource = { ...original, sourceRoot, targetRoot, sourceAbsent: !values.some(value => value.path.absolute === sourcePath.absolute),
        sourceObservationOrigin: 'AUTHENTICATED_RECOVERY_MATERIAL_FD', sourceObservation: material.observation,
        targetObservation: targetFile?.observation.links === '1' ? targetFile.observation : null,
        sourceIdentity: await observeRelocationRootIdentity(sourceRoot, io), targetIdentity: await observeRelocationRootIdentity(targetRoot, io), rewriteMaterial,
        frozen: { ...original.frozen, operationIds, source: sourceEndpoint, target: targetEndpoint, action,
          before: { sha256: material.observation.sha256, bytes: String(material.observation.bytes) }, after: desired,
          sourceObservationFingerprint: relocationHash(material.observation), targetObservationFingerprint: relocationHash({ path: targetPath, observation: targetFile?.observation ?? null }),
          attributesFingerprint: relocationHash(original.attributes) },
        recovery: { originPlanId: origin.plan.planId, originResourceId: original.frozen.resourceId,
          material: { root: material.path.root, relative: material.path.relative, observation: material.observation }, target: targetFile ? { observation: targetFile.observation, aliases } : null,
          retainedSource: retainedFile && !unregisteredRollback ? { root: retainedRoot, endpoint: retainedEndpoint, observation: retainedFile.observation,
            identity: await observeRelocationRootIdentity(retainedRoot, io) } : null } };
      // 未登记rollback必须认证并保全本域安装目标；相同字节的外部副本不能被搬走。
      const formerTarget = unregisteredRollback
        && targetPath.absolute !== path.join(original.targetRoot.path, original.frozen.target.relative)
        ? await named(state, await captureRelocationPath(original.targetRoot, original.frozen.target.relative), io, true) : null;
      if (formerTarget) {
        if (!matches(formerTarget.observation, original.frozen.after) || !authenticatedOwnership(input.family, original, formerTarget.observation)) return relocationFail('UNKNOWN_REFERENCE');
        if (!sameSourceFileAttributes(await observeSourceFileAttributes(formerTarget.path.absolute, formerTarget.handle), original.attributes)) return relocationFail('SOURCE_CHANGED');
        observations.push(formerTarget);
      }
      files.push({ original, capture, material, target: targetPath, targetFile, slots, evacuation: formerTarget, retained }); resources.push(capture);
      if (!mappings.some(value => value.source.libraryRootId === sourceEndpoint.libraryRootId && value.source.sourceRootId === sourceEndpoint.sourceRootId
        && value.target.libraryRootId === targetEndpoint.libraryRootId && value.target.sourceRootId === targetEndpoint.sourceRootId)) mappings.push({ mappingId: randomUUID(), source: sourceEndpoint, target: targetEndpoint,
        sourceCapabilityFingerprint: relocationHash(sourceRoot), targetCapabilityFingerprint: relocationHash(targetRoot), sourcePhysicalRootFingerprint: capture.sourceIdentity.fingerprint,
        targetPhysicalRootFingerprint: capture.targetIdentity.fingerprint, sourceAncestorFingerprint: relocationHash(sourcePath.ancestors), targetAncestorFingerprint: relocationHash(targetPath.ancestors) });
    }
    // 每卷完整空间上界，保全旧材料计入；不依删除旧stage腾空或宣称全局原子。
    const volumes = new Map<string, { root: RootCapability; bytes: bigint }>(); let reservedBytes = 0n;
    for (const file of files.filter(value => !value.targetFile)) {
      const amount = BigInt(file.capture.frozen.after.bytes) * 2n, prior = volumes.get(file.target.root.dev) ?? { root: file.target.root, bytes: 0n };
      prior.bytes += amount; volumes.set(file.target.root.dev, prior); reservedBytes += amount;
      if (!file.slots.some(value => value.root.dev === file.target.root.dev)) return relocationFail('RECOVERY_REQUIRED');
    }
    for (const volume of volumes.values()) { const fs = await statfs(volume.root.path, { bigint: true }); if (fs.bavail * fs.bsize < volume.bytes) return relocationFail('SPACE_INSUFFICIENT'); }
    if (!Number.isSafeInteger(input.retainedSourceBytes) || input.retainedSourceBytes < 0) return relocationFail('OVER_BUDGET');
    const areas = await Promise.all([...new Set(files.flatMap(value => value.slots.map(slot => path.dirname(slot.root.path))))].map(privateRoot));
    const usage = await observeRelocationMaterialUsage(areas, io);
    if (BigInt(usage) + BigInt(input.retainedSourceBytes) + reservedBytes > BigInt(dto.LOCAL_RELOCATION_PLAN_BUDGET.retainedMaterialsBytes)) return relocationFail('OVER_BUDGET');
    const inventories = await Promise.all([...new Set(files.flatMap(file => [path.dirname(path.join(file.capture.sourceRoot.path, file.capture.frozen.source.relative)), file.target.parent]))]
      .map(async directory => ({ directory, entries: await directoryInventory(directory) })));
    const materialObservations = observations.map(value => ({ root: value.path.root, relative: value.path.relative, observation: value.observation }));
    const fingerprint = relocationHash({ planId: input.planId, origin: recoveryOrigin, resources, inventories, materialObservations, pathObservations: paths, reservedBytes: String(reservedBytes),
      retainedMaterialsBytes: String(usage), retainedSourceBytes: String(input.retainedSourceBytes), paths: files.map(value => ({ target: value.target.absolute, slots: value.slots.map(slot => slot.absolute) })) });
    const cap = Object.freeze({ fingerprint }) as PreparedRelocationRecovery;
    prepared.set(cap, { group: input.group, planId: input.planId, family: input.family, origin: recoveryOrigin, files, snapshots: input.snapshots, directories, paths, observations, inventories, active: true, consumed: false });
    return { access: cap, origin: recoveryOrigin, resources, operations, mappings, edges: root.edges.map(value => ({ ...value })), rootRelink, reservationFingerprint: fingerprint, inventories, materialObservations, pathObservations: paths };
  } finally { state.preparing = false; state.claims.retain(); }
}

async function copy(source: FileHandle, target: FileHandle, bytes: number, options: RelocationIoOptions): Promise<void> {
  const buffer = Buffer.alloc(dto.LOCAL_RELOCATION_PLAN_BUDGET.hashChunkBytes); let at = 0;
  while (at < bytes) { checkRelocationIo(options); const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, bytes - at), at); if (!bytesRead) return relocationFail('SOURCE_CHANGED');
    let written = 0; while (written < bytesRead) { checkRelocationIo(options); const part = await target.write(buffer, written, bytesRead - written, at + written); if (!part.bytesWritten) return relocationFail('IO_FAILED'); written += part.bytesWritten; } at += bytesRead; }
  await target.truncate(bytes); await target.sync();
}
export interface RelocationRecoveryExecution {
  access: PreparedRelocationRecovery; signal: AbortSignal; assertCurrent(): void; verifyCatalog(): void;
  phase(fact: RelocationPublisherFact): void;
  verifyProtection(claims: PhysicalWriteClaims, sources: readonly PublicationSource[], namespace: (source: PublicationSource) => SourceNamespaceHeldObservation | undefined): Promise<void>;
  prepare(files: readonly RelocationPublishedResource[], access: RelocationReadAccess): Promise<unknown>;
  commit(files: readonly RelocationPublishedResource[], access: RelocationReadAccess, reads: unknown): void;
  resolved(files: readonly RelocationPublishedResource[], family: readonly RelocationStoredPlan[]): void;
}
/** 原保护只整组transfer/delegate；所有真实FD quiet且每代durable resolved后才逐代消义务。 */
export async function executeRelocationRecovery(input: RelocationRecoveryExecution): Promise<readonly RelocationPublishedResource[]> {
  const value = prepared.get(input.access); if (!value?.active || value.consumed) return relocationFail('GRANT_CONSUMED');
  const state = group(value.group); value.consumed = true;
  const io = { signal: input.signal, deadlineAt: Date.now() + dto.LOCAL_RELOCATION_PLAN_BUDGET.runtimeDeadlineMs };
  const old = state.namespace, mapped = old.scope.operations.map(operation => {
    const mapping = value.origin.operationMappings.find(value => value.originOperationId === operation.operationId); if (!mapping) return relocationFail('RECOVERY_REQUIRED');
    return { operationId: mapping.operationId, originOperationId: operation.operationId, name: operation.name };
  });
  const token = delegateSourceNamespaceRecovery(old.token, { datasetId: old.scope.datasetId, originPlanId: old.scope.planId, recoveryPlanId: value.planId, originBinding: old.scope.originBinding, operations: mapped });
  state.ancestors.push(old); state.namespace = { token, scope: { datasetId: old.scope.datasetId, planId: value.planId, originBinding: old.scope.originBinding,
    operations: mapped.map(({ originOperationId: _old, ...operation }) => operation) } }; state.currentPlanId = value.planId;
  let access: RelocationReadAccess | null = null;
  const results: RelocationPublishedResource[] = [];
  const check = (): void => { input.assertCurrent(); checkRelocationIo(io); assertSourceNamespaceHeld(token, state.namespace.scope); input.verifyCatalog(); };
  const fact = (file: RecoveryFile, phase: dto.LocalRelocationPlanPhase, target: RelocationFileObservation | null = null, quiet = false): void => input.phase({ operationId: file.capture.frozen.operationIds[0]!,
    resourceId: file.capture.frozen.resourceId, phase, sourceObservation: file.capture.sourceObservation, targetObservation: target,
    stage: file.slots.find(value => value.root.dev === file.target.root.dev)?.absolute ?? null, quarantine: file.slots.find(value => value.absolute.endsWith('.capture'))?.absolute ?? null,
    retained: file.slots.find(value => value.root.dev === (file.capture.recovery?.retainedSource?.root.dev ?? file.capture.sourceRoot.dev) && value.absolute.endsWith('.backup'))?.absolute
      ?? file.slots.find(value => value.root.dev === (file.capture.recovery?.retainedSource?.root.dev ?? file.capture.sourceRoot.dev))?.absolute ?? null, quiet });
  const namespaceFor = (source: PublicationSource): SourceNamespaceHeldObservation | undefined => {
    const found = state.namespace.scope.operations.find(value => value.name.absolute === path.join(source.root.path, source.relative));
    return found ? { token, datasetId: state.namespace.scope.datasetId, planId: value.planId, originBinding: state.namespace.scope.originBinding, operationId: found.operationId } : undefined;
  };
  async function sync(absolute: string): Promise<void> { const observed = value!.paths.find(value => value.absolute === absolute); if (!observed) return relocationFail('RECOVERY_REQUIRED');
    await verifyRelocationPath(observed); const handle = value!.directories.get(path.dirname(absolute)); if (!handle || handle.fd === -1) return relocationFail('RECOVERY_REQUIRED'); await handle.sync(); }
  async function freeSlot(file: RecoveryFile, dev?: string): Promise<RelocationPathObservation> {
    for (const slot of file.slots) { await verifyRelocationPath(slot); if ((!dev || slot.root.dev === dev) && !await exists(slot.absolute)) return slot; }
    return relocationFail('COLLISION');
  }
  try {
    check();
    // 叶暂缺也必须保持整个祖先链；空目录清单相等不能证明父目录仍是READY捕获的同一个对象。
    for (const observed of value.paths) await verifyRelocationPath(observed);
    for (const inventory of value.inventories) if (!same(await directoryInventory(inventory.directory), inventory.entries)) return relocationFail('SOURCE_CHANGED');
    // 全preview观察先整组复核，任何外部修改都在第一处新发布前拒绝。
    for (const observed of value.observations) {
      await verifyRelocationPath(observed.path); const actual = await observeRelocationFile(observed.handle, { ...io, expectedLinks: BigInt(observed.observation.links) });
      if (!same(actual, observed.observation)) return relocationFail('SOURCE_CHANGED');
      const named = await lstat(observed.path.absolute, { bigint: true }); if (named.isSymbolicLink() || relocationSignature(named) !== actual.signature) return relocationFail('SOURCE_CHANGED');
    }
    const live = state.handles.filter(handle => handle.fd !== -1); state.claims = await transferPhysicalWriteClaims(state.claims, [], live);
    for (const file of value.files) { await assertRelocationRootIdentity(file.capture.sourceRoot, file.capture.sourceIdentity, io); await assertRelocationRootIdentity(file.capture.targetRoot, file.capture.targetIdentity, io);
      fact(file, 'RESERVED'); fact(file, 'SOURCE_VERIFIED'); }
    await input.verifyProtection(state.claims, value.files.map(file => ({ root: file.material.path.root,
      relative: file.material.path.relative, expectedSignature: file.material.observation.signature })), namespaceFor);
    for (const file of value.files) {
      check();
      if (file.evacuation) {
        const slot = await freeSlot(file, file.evacuation.path.root.dev);
        await verifyRelocationPath(file.evacuation.path); await verifyRelocationPath(slot);
        fact(file, 'SOURCE_CAPTURED', file.evacuation.observation); await rename(file.evacuation.path.absolute, slot.absolute); await sync(file.evacuation.path.absolute); await sync(slot.absolute);
        // inode/birth/全Hash完整相等才保全该本域安装对象；不会删除外部同名副本。
        const isolated = await named(state, slot, io, true); if (!isolated || !inode(isolated.observation, file.evacuation.observation) || !matches(isolated.observation, file.original.frozen.after)) return relocationFail('VERIFY_FAILED');
      }
      if (file.capture.recovery!.target?.aliases.length) {
        const alias = file.capture.recovery!.target!.aliases[0]!, absolute = path.join(alias.root.path, alias.relative);
        const aliasPath = value.paths.find(value => value.absolute === absolute); if (!aliasPath) return relocationFail('RECOVERY_REQUIRED');
        await verifyRelocationPath(aliasPath); await verifyRelocationPath(file.target);
        const twin = await lstat(absolute, { bigint: true }), target = await lstat(file.target.absolute, { bigint: true });
        if (twin.isSymbolicLink() || target.isSymbolicLink() || twin.nlink !== 2n || target.nlink !== 2n || twin.dev !== target.dev || twin.ino !== target.ino
          || String(twin.birthtimeNs) !== file.capture.recovery!.target!.observation.birthtimeNs) return relocationFail('TARGET_CHANGED');
        fact(file, 'TARGET_INSTALLED'); await verifyRelocationPath(aliasPath); await verifyRelocationPath(file.target); await unlink(absolute); await sync(absolute); await sync(file.target.absolute);
      }
      if (!file.targetFile) {
        let slot: RelocationPathObservation;
        try { slot = await freeSlot(file, file.target.root.dev); }
        catch (error) {
          // 一个中断stage可保全到另一空slot；完整复制/独立Hash后才复用原stage，绝不截掉唯一材料。
          const partial = file.slots.find(value => value.root.dev === file.target.root.dev && !value.absolute.endsWith('.backup'));
          if (!partial) throw error; const actual = await named(state, partial, io); if (!actual) throw error;
          const spare = await freeSlot(file); await verifyRelocationPath(partial); await verifyRelocationPath(spare);
          const backup = await open(spare.absolute, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await keep(state, backup);
          await copy(actual.handle, backup, actual.observation.bytes, io); const proof = await observeRelocationFile(backup, io);
          if (!matches(proof, { sha256: actual.observation.sha256, bytes: String(actual.observation.bytes) })) return relocationFail('VERIFY_FAILED'); await sync(spare.absolute);
          slot = partial;
        }
        let output: FileHandle;
        await verifyRelocationPath(slot); await verifyRelocationPath(file.target); await verifyRelocationPath(file.material.path);
        const oldStage = await exists(slot.absolute);
        if (oldStage) { output = await open(slot.absolute, constants.O_RDWR | constants.O_NOFOLLOW); await keep(state, output); }
        else { output = await open(slot.absolute, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await keep(state, output); }
        let source = file.material.handle, bytes = file.material.observation.bytes;
        if (file.capture.rewriteMaterial) {
          source = await open(file.capture.rewriteMaterial.path, constants.O_RDONLY | constants.O_NOFOLLOW); await keep(state, source);
          const proof = await observeRelocationFile(source, io); if (!matches(proof, file.capture.frozen.after)) return relocationFail('VERIFY_FAILED'); bytes = proof.bytes;
        }
        await copy(source, output, bytes, io); await output.chmod(Number(file.capture.attributes.mode)); await output.sync();
        const staged = await observeRelocationFile(output, io);
        if (!matches(staged, file.capture.frozen.after) || !sameSourceFileAttributes(await observeSourceFileAttributes(slot.absolute, output), file.capture.attributes)) return relocationFail('VERIFY_FAILED');
        fact(file, 'TARGET_STAGED', staged); fact(file, 'TARGET_SYNCED', staged);
        if (await exists(file.target.absolute)) return relocationFail('COLLISION');
        fact(file, 'TARGET_INSTALLED', staged); await verifyRelocationPath(slot); await verifyRelocationPath(file.target);
        await link(slot.absolute, file.target.absolute); await sync(file.target.absolute); await verifyRelocationPath(slot); await unlink(slot.absolute); await sync(slot.absolute);
      }
      const target = await named(state, file.target, io); if (!target || !matches(target.observation, file.capture.frozen.after)
        || !sameSourceFileAttributes(await observeSourceFileAttributes(file.target.absolute, target.handle), file.capture.attributes)) return relocationFail('VERIFY_FAILED');
      file.targetFile = target; fact(file, 'VERIFIED_TARGET', target.observation);
      results.push({ operationId: file.capture.frozen.operationIds[0]!, resourceId: file.capture.frozen.resourceId, capture: file.capture, observation: target.observation, sourceRetained: file.retained });
    }
    if (value.origin.action !== 'reconcile') {
      access = await createRelocationReadAccess(value.files.map(file => ({ operationId: file.capture.frozen.operationIds[0]!, resourceId: file.capture.frozen.resourceId,
        path: file.target, handle: file.targetFile!.handle, observation: file.targetFile!.observation })), state.claims, token, state.namespace.scope, input.signal, io.deadlineAt);
      const reads = await input.prepare(results, access); check();
      await input.verifyProtection(state.claims, results.map(result => { const file = value.files.find(value => value.capture.frozen.resourceId === result.resourceId)!;
        return { root: file.capture.targetRoot, relative: file.capture.frozen.target.relative, expectedSignature: result.observation.signature }; }), namespaceFor);
      for (const file of value.files) if (!same(await observeRelocationFile(file.targetFile!.handle, io), file.targetFile!.observation)) return relocationFail('TARGET_CHANGED');
      input.commit(results, access, reads); for (const file of value.files) { fact(file, 'REGISTERED', file.targetFile!.observation); if (file.retained) fact(file, 'SOURCE_RETAINED', file.targetFile!.observation); }
      revokeRelocationReadAccess(access); access = null;
    } else {
      for (const file of value.files) if (file.retained) fact(file, 'SOURCE_RETAINED', file.targetFile!.observation);
    }
    input.assertCurrent(); input.verifyCatalog();
    // quiet记录与祖先resolved发生在保护仍真实持有时；没有数字FD或布尔quiet替代真实关闭。
    await closePhysicalWriteClaimDescriptors(state.claims);
    for (const file of value.files) fact(file, 'TERMINAL', file.targetFile!.observation, true);
    input.resolved(results, value.family);
    await state.claims.release();
    await resolveSourceNamespaceRecovery(token, token.operationIds);
    for (const ancestor of [...state.ancestors].reverse()) {
      if ('recoveryPlanId' in ancestor.token) await resolveSourceNamespaceRecovery(ancestor.token, ancestor.token.operationIds);
      else await resolveSourceNamespaceOrigin(ancestor.token, ancestor.token.operationIds);
    }
    state.active = false; value.active = false; return Object.freeze(results);
  } catch (error) {
    if (access) revokeRelocationReadAccess(access);
    if (state.claims.state !== 'released') state.claims.retain(); retainSourceNamespaceWrite(token);
    for (const file of value.files) try { fact(file, 'UNKNOWN', file.targetFile?.observation ?? null); } catch { /* 原durable来源和意图保留。 */ }
    throw new RelocationPublicationRecoveryRequired(state.claims.state === 'released' ? null : state.claims, state.namespace, [], state.handles, 'RECOVERY_REQUIRED', error);
  }
}
