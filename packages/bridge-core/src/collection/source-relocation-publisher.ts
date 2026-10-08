import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rename, statfs, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { RootCapability, PublicationSource } from '../recording/source-files.js';
import { acquirePhysicalWriteClaims, closePhysicalWriteClaimDescriptors, physicalWriteClaimDescriptors, registerPhysicalWriteClaimDescriptors,
  transferPhysicalWriteClaims, type PhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import { acquireSourceNamespaceWrite, assertSourceNamespaceHeld, captureSourceNamespace, releaseSourceNamespaceWrite, retainSourceNamespaceWrite,
  type SourceNamespaceHeldObservation, type SourceNamespaceHeldScope, type SourceNamespaceOperation, type SourceNamespaceOriginBinding, type SourceNamespaceWriteToken } from '../stream/source-namespace-claims.js';
import { observeSourceFileAttributes, sameSourceFileAttributes } from './source-writes-publisher.js';
import { relocationFail, relocationHash, type RelocationCapturedResource, type RelocationPublisherFact, type RelocationStoredPlan } from './local-relocation-journal.js';
import { assertRelocationRootIdentity, sameRelocationStorage } from './source-relocation-root-identity.js';
import { assertSameRelocationBytes, captureRelocationPath, checkRelocationIo, createRelocationReadAccess, observeRelocationFile,
  relocationSignature, revokeRelocationReadAccess, verifyRelocationPath, type RelocationFileObservation, type RelocationIoOptions,
  type RelocationPathObservation, type RelocationReadAccess, type RelocationReadTarget } from './source-relocation-verify.js';

export const RELOCATION_PUBLISHER_PROFILE = 'NONATOMIC_CAPTURE_NO_OVERWRITE_WHOLE_BYTES_V1' as const;
export interface RelocationStorageFile {
  resourceId: string; sourcePrivateRoot: RootCapability; targetPrivateRoot: RootCapability;
  backup: string; quarantine: string; stage: string;
}

export interface RelocationCleanupInput {
  stored: RelocationStoredPlan; sourceResourceIds: readonly string[]; binding: SourceNamespaceOriginBinding; signal: AbortSignal;
  assertCurrent(): void; verifyCatalog(): void; phase(fact: RelocationPublisherFact): void;
  verifyProtection(claims: PhysicalWriteClaims, sources: readonly PublicationSource[], namespace: (source: PublicationSource) => SourceNamespaceHeldObservation | undefined): Promise<void>;
}
/** 冷启动仅重新持有认证journal指向的真实名字/FD，不自动发布、删除或登记目录事实。 */
export async function holdRelocationRecoveryProtection(stored: RelocationStoredPlan, projectionFingerprint: string, family: readonly RelocationStoredPlan[] = [stored]): Promise<RelocationPublicationRecoveryRequired> {
  if (!stored.ready || !dto.isLocalRelocationPlanHash(projectionFingerprint)) return relocationFail('RECOVERY_REQUIRED');
  if (!family.length || family[0]!.plan.planId !== stored.plan.planId || family.some(value => value.plan.datasetId !== stored.plan.datasetId || !value.ready)) return relocationFail('RECOVERY_REQUIRED');
  const named = new Map<string, { root: RootCapability; relative: string }>();
  for (const member of family) for (const resource of member.resources) {
    for (const [root, relative] of [[resource.sourceRoot, resource.frozen.source.relative], [resource.targetRoot, resource.frozen.target.relative]] as const)
      named.set(path.join(root.path, relative), { root, relative });
    if (resource.storage) for (const [root, relative] of [[resource.storage.sourcePrivateRoot, resource.storage.backup], [resource.storage.sourcePrivateRoot, resource.storage.quarantine],
      [resource.storage.targetPrivateRoot, resource.storage.stage]] as const) {
      if (!family.some(value => value.plan.planId === path.basename(root.path)) || stored.resources.some(value => inside(value.sourceRoot.path, root.path) || inside(value.targetRoot.path, root.path))) return relocationFail('RECOVERY_REQUIRED');
      await ownedDirectory(root.path, false); named.set(path.join(root.path, relative), { root, relative });
    }
    if (resource.recovery) {
      named.set(path.join(resource.recovery.material.root.path, resource.recovery.material.relative), { root: resource.recovery.material.root, relative: resource.recovery.material.relative });
      if (resource.recovery.retainedSource) { const retained = resource.recovery.retainedSource; named.set(path.join(retained.root.path, retained.endpoint.relative), { root: retained.root, relative: retained.endpoint.relative }); }
    }
    for (const event of member.events) if (event.kind === 'phase' && event.fact.resourceId === resource.frozen.resourceId) {
      for (const absolute of [event.fact.stage, event.fact.quarantine, event.fact.retained]) if (absolute !== null && !named.has(absolute)) {
        const expected = [`${resource.frozen.resourceId}.stage`, `${resource.frozen.resourceId}.capture`, `${resource.frozen.resourceId}.backup`, `${resource.frozen.resourceId}.cleanup`];
        if (!expected.includes(path.basename(absolute)) || !family.some(value => path.basename(path.dirname(absolute)) === value.plan.planId)) return relocationFail('RECOVERY_REQUIRED');
        const root = await ownedDirectory(path.dirname(absolute), false);
        if (stored.resources.some(value => inside(value.sourceRoot.path, root.path) || inside(value.targetRoot.path, root.path))) return relocationFail('RECOVERY_REQUIRED');
        named.set(absolute, { root, relative: path.basename(absolute) });
      }
    }
  }
  const handles: FileHandle[] = [], directoryPaths = new Set<string>(), operations: SourceNamespaceOperation[] = [];
  const binding = { datasetId: stored.plan.datasetId, originPlanId: stored.plan.planId, planHash: stored.plan.planHash, contextFingerprint: stored.plan.contextFingerprint,
    journalSequence: stored.plan.journalSequence, projectionFingerprint };
  let claims: PhysicalWriteClaims | null = null, namespace: { token: SourceNamespaceWriteToken; scope: SourceNamespaceHeldScope } | null = null;
  try {
    for (const { root, relative } of named.values()) {
      const observed = await captureRelocationPath(root, relative), resource = stored.resources.find(value => value.sourceRoot.id === root.id && value.frozen.source.relative === relative
        || value.targetRoot.id === root.id && value.frozen.target.relative === relative || relative.startsWith(value.frozen.resourceId));
      if (!resource) return relocationFail('RECOVERY_REQUIRED');
      operations.push({ operationId: resource.frozen.operationIds[0]!, name: observed.namespace });
      for (const ancestor of observed.ancestors) if (!directoryPaths.has(ancestor.absolute)) { directoryPaths.add(ancestor.absolute); handles.push(await open(ancestor.absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)); }
      const info = await exists(observed.absolute);
      if (info) { if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(dto.LOCAL_RELOCATION_PLAN_BUDGET.singleSourceBytes)) return relocationFail('RECOVERY_REQUIRED');
        const handle = await open(observed.absolute, constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(handle);
        const actual = await handle.stat({ bigint: true }); if (actual.dev !== info.dev || actual.ino !== info.ino || actual.birthtimeNs !== info.birthtimeNs) return relocationFail('RECOVERY_REQUIRED'); }
    }
    const scope = { datasetId: binding.datasetId, planId: binding.originPlanId, originBinding: binding, operations };
    namespace = { token: await acquireSourceNamespaceWrite({ ...binding, operations }), scope }; retainSourceNamespaceWrite(namespace.token);
    const resources = await Promise.all(handles.map(async handle => physical(await handle.stat({ bigint: true }))));
    claims = await acquirePhysicalWriteClaims([...new Map(resources.map(value => [key(value), value])).values()]); registerPhysicalWriteClaimDescriptors(claims, handles); claims.retain();
    return new RelocationPublicationRecoveryRequired(claims, namespace, [], handles, 'RECOVERY_REQUIRED');
  } catch (error) {
    if (claims) { claims.retain(); throw new RelocationPublicationRecoveryRequired(claims, namespace, [], handles, 'RECOVERY_REQUIRED', error); }
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    if (closed.some(result => result.status === 'rejected') || handles.some(handle => handle.fd !== -1) || namespace) throw new RelocationPublicationRecoveryRequired(null, namespace, [], handles, 'RECOVERY_REQUIRED', error);
    throw error;
  }
}
/** cleanup是独立具体授权后的真实捕获/复核/删除；原COPY授权从不走此入口。 */
export async function cleanupRelocationSources(input: RelocationCleanupInput): Promise<void> {
  const selected = input.stored.resources.filter(resource => input.sourceResourceIds.includes(resource.frozen.resourceId));
  const movingAssets = new Set(input.stored.operations.flatMap(operation => operation.operation.assetId ? [operation.operation.assetId] : []));
  if (!selected.length || selected.length !== input.sourceResourceIds.length || new Set(input.sourceResourceIds).size !== selected.length
    || !selected.every(resource => input.stored.plan.cleanup.sourceResourceIds.includes(resource.frozen.resourceId))) return relocationFail('CLEANUP_NOT_ALLOWED');
  if (selected.some(resource => resource.frozen.sharedMemberIds.some(assetId => !movingAssets.has(assetId)))) return relocationFail('SHARED_REFERENCE');
  const handles: FileHandle[] = [], records: { capture: RelocationCapturedResource; source: RelocationPathObservation; target: RelocationPathObservation;
    isolation: RelocationPathObservation; sourceHandle: FileHandle; targetHandle: FileHandle; sourceObservation: RelocationFileObservation; targetObservation: RelocationFileObservation; intent: boolean }[] = [];
  const directories = new Map<string, FileHandle>(), operations: SourceNamespaceOperation[] = [];
  let claims: PhysicalWriteClaims | null = null, namespace: { token: SourceNamespaceWriteToken; scope: SourceNamespaceHeldScope } | null = null, unknown = false;
  const options = { signal: input.signal, deadlineAt: Date.now() + dto.LOCAL_RELOCATION_PLAN_BUDGET.runtimeDeadlineMs };
  const check = (): void => { input.assertCurrent(); checkRelocationIo(options); if (namespace) assertSourceNamespaceHeld(namespace.token, namespace.scope); };
  const keep = (handle: FileHandle): FileHandle => { if (!handles.includes(handle)) handles.push(handle); return handle; };
  const directory = async (absolute: string): Promise<FileHandle> => { const prior = directories.get(absolute); if (prior) return prior;
    const handle = keep(await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)); directories.set(absolute, handle); return handle; };
  const fact = (record: typeof records[number], phase: dto.LocalRelocationPlanPhase, quiet = false): void => input.phase({ operationId: record.capture.frozen.operationIds[0]!, resourceId: record.capture.frozen.resourceId,
    phase, sourceObservation: record.capture.sourceObservation, targetObservation: record.targetObservation, stage: null, quarantine: record.isolation.absolute, retained: null, quiet });
  try {
    check(); input.verifyCatalog();
    for (const capture of selected) {
      const retainedSource = capture.recovery?.retainedSource, sourceRoot = retainedSource?.root ?? capture.sourceRoot;
      const sourceEndpoint = retainedSource?.endpoint ?? capture.frozen.source, sourceObservation = retainedSource?.observation ?? capture.sourceObservation;
      if (capture.recovery && !retainedSource || !capture.recovery && capture.sourceAbsent || capture.frozen.action === 'move'
        || sourceRoot.id === capture.targetRoot.id && sourceEndpoint.relative === capture.frozen.target.relative) return relocationFail('CLEANUP_NOT_ALLOWED');
      await assertRelocationRootIdentity(sourceRoot, retainedSource?.identity ?? capture.sourceIdentity, options); await assertRelocationRootIdentity(capture.targetRoot, capture.targetIdentity, options);
      const source = await captureRelocationPath(sourceRoot, sourceEndpoint.relative), target = await captureRelocationPath(capture.targetRoot, capture.frozen.target.relative);
      const retained = [...input.stored.events].reverse().find(event => event.kind === 'phase' && event.fact.resourceId === capture.frozen.resourceId && event.fact.retained !== null);
      if (!retained || retained.kind !== 'phase') return relocationFail('RECOVERY_REQUIRED');
      const privatePath = path.dirname(retained.fact.retained!), privateRoot = await ownedDirectory(privatePath, false);
      if (privateRoot.dev !== sourceRoot.dev) return relocationFail('ROOT_IDENTITY_UNPROVEN');
      const isolation = await captureRelocationPath(privateRoot, `${capture.frozen.resourceId}.cleanup`);
      if (await exists(isolation.absolute)) return relocationFail('COLLISION');
      for (const observed of [source, target, isolation]) {
        for (const ancestor of observed.ancestors) await directory(ancestor.absolute);
        operations.push({ operationId: capture.frozen.operationIds[0]!, name: observed.namespace });
      }
      const sourceHandle = keep(await open(source.absolute, constants.O_RDONLY | constants.O_NOFOLLOW)), targetHandle = keep(await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW));
      const targetObservation = await observeRelocationFile(targetHandle, options);
      const prior = [...input.stored.events].reverse().find(event => event.kind === 'phase' && event.fact.resourceId === capture.frozen.resourceId && event.fact.targetObservation !== null);
      if (!prior || prior.kind !== 'phase' || relocationHash(prior.fact.targetObservation) !== relocationHash(targetObservation)) return relocationFail('TARGET_CHANGED');
      if (targetObservation.sha256 !== capture.frozen.after.sha256 || String(targetObservation.bytes) !== capture.frozen.after.bytes) return relocationFail('VERIFY_FAILED');
      records.push({ capture, source, target, isolation, sourceHandle, targetHandle, sourceObservation, targetObservation, intent: false });
    }
    // 真保护覆盖整份READY闭集；具体grant只允许selected的删除，未知后不能把剩余资源移出保护族。
    for (const capture of input.stored.resources) {
      const names: { root: RootCapability; relative: string }[] = [{ root: capture.sourceRoot, relative: capture.frozen.source.relative }, { root: capture.targetRoot, relative: capture.frozen.target.relative }];
      if (capture.storage) names.push({ root: capture.storage.sourcePrivateRoot, relative: capture.storage.backup }, { root: capture.storage.sourcePrivateRoot, relative: capture.storage.quarantine }, { root: capture.storage.targetPrivateRoot, relative: capture.storage.stage });
      if (capture.recovery) { names.push({ root: capture.recovery.material.root, relative: capture.recovery.material.relative });
        if (capture.recovery.retainedSource) names.push({ root: capture.recovery.retainedSource.root, relative: capture.recovery.retainedSource.endpoint.relative }); }
      for (const named of names) {
        const observed = await captureRelocationPath(named.root, named.relative);
        if (operations.some(value => value.operationId === capture.frozen.operationIds[0] && value.name.absolute === observed.absolute)) continue;
        operations.push({ operationId: capture.frozen.operationIds[0]!, name: observed.namespace });
        for (const ancestor of observed.ancestors) await directory(ancestor.absolute);
        const info = await exists(observed.absolute);
        if (info) { if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return relocationFail('UNKNOWN_REFERENCE');
          const handle = keep(await open(observed.absolute, constants.O_RDONLY | constants.O_NOFOLLOW)), opened = await handle.stat({ bigint: true });
          if (opened.dev !== info.dev || opened.ino !== info.ino || opened.birthtimeNs !== info.birthtimeNs) return relocationFail('SOURCE_CHANGED'); }
      }
    }
    const uniqueOperations = [...new Map(operations.map(operation => [`${operation.operationId}\0${operation.name.absolute}`, operation])).values()];
    const scope = { datasetId: input.binding.datasetId, planId: input.binding.originPlanId, originBinding: input.binding, operations: uniqueOperations };
    namespace = { token: await acquireSourceNamespaceWrite({ ...input.binding, operations: uniqueOperations }), scope };
    const physicals = await Promise.all(handles.map(async handle => physical(await handle.stat({ bigint: true }))));
    claims = await acquirePhysicalWriteClaims([...new Map(physicals.map(resource => [key(resource), resource])).values()]); registerPhysicalWriteClaimDescriptors(claims, handles);
    const namespaceFor = (source: PublicationSource): SourceNamespaceHeldObservation | undefined => {
      const match = uniqueOperations.find(operation => operation.name.absolute === path.join(source.root.path, source.relative));
      return match && namespace ? { token: namespace.token, datasetId: scope.datasetId, planId: scope.planId, originBinding: scope.originBinding, operationId: match.operationId } : undefined;
    };
    for (const record of records) {
      await verifyRelocationPath(record.source); await verifyRelocationPath(record.target);
      if (relocationHash(await observeRelocationFile(record.sourceHandle, options)) !== relocationHash(record.sourceObservation)
        || relocationHash(await observeRelocationFile(record.targetHandle, options)) !== relocationHash(record.targetObservation)) return relocationFail('SOURCE_CHANGED');
    }
    await input.verifyProtection(claims, records.flatMap(record => [{ root: record.source.root, relative: record.source.relative, expectedSignature: record.sourceObservation.signature },
      { root: record.capture.targetRoot, relative: record.capture.frozen.target.relative, expectedSignature: record.targetObservation.signature }]), namespaceFor);
    check(); input.verifyCatalog();
    // 完整选择在任一原件删除前复核；不允许把依赖CUE/歌词/封面拆成隐式cleanup。
    for (const record of records) {
      check(); await verifyRelocationPath(record.source); await verifyRelocationPath(record.target);
      if (await exists(record.isolation.absolute)) return relocationFail('COLLISION');
      fact(record, 'CLEANUP_REQUESTED'); record.intent = true;
      await rename(record.source.absolute, record.isolation.absolute);
      await (await directory(record.source.parent)).sync(); await (await directory(record.isolation.parent)).sync();
      const captured = await observeRelocationFile(record.sourceHandle, options), isolated = await lstat(record.isolation.absolute, { bigint: true });
      if (captured.sha256 !== record.sourceObservation.sha256 || captured.bytes !== record.sourceObservation.bytes
        || key(captured.physical) !== key(record.sourceObservation.physical) || captured.birthtimeNs !== record.sourceObservation.birthtimeNs
        || isolated.isSymbolicLink() || relocationSignature(isolated) !== captured.signature) return relocationFail('SOURCE_CHANGED');
      if (relocationHash(await observeRelocationFile(record.targetHandle, options)) !== relocationHash(record.targetObservation)) return relocationFail('TARGET_CHANGED');
      await unlink(record.isolation.absolute); await (await directory(record.isolation.parent)).sync(); fact(record, 'SOURCE_REMOVED'); fact(record, 'DIRECTORY_SYNCED');
    }
  } catch (error) {
    unknown = records.some(record => record.intent);
    if (unknown) { claims?.retain(); if (namespace) retainSourceNamespaceWrite(namespace.token);
      for (const record of records) try { fact(record, 'UNKNOWN'); } catch { /* 原意图保留。 */ }
      throw new RelocationPublicationRecoveryRequired(claims, namespace, [], handles, 'RECOVERY_REQUIRED', error); }
    throw error;
  } finally {
    if (!unknown) {
      try {
        if (claims) await closePhysicalWriteClaimDescriptors(claims);
        else { const closed = await Promise.allSettled(handles.map(handle => handle.close())); if (closed.some(result => result.status === 'rejected') || handles.some(handle => handle.fd !== -1)) throw new Error('cleanup真实FD关闭未核实。'); }
        for (const record of records) fact(record, 'TERMINAL', true);
        await claims?.release(); if (namespace) await releaseSourceNamespaceWrite(namespace.token, namespace.token.operationIds);
      } catch (error) { const retained = claims?.state === 'released' ? null : claims; retained?.retain(); if (namespace) retainSourceNamespaceWrite(namespace.token);
        throw new RelocationPublicationRecoveryRequired(retained, namespace, [], handles, 'RECOVERY_REQUIRED', error); }
    }
  }
}
declare const relocationStorageBrand: unique symbol;
export interface RelocationStorageReservation { readonly [relocationStorageBrand]: true; readonly planId: string; readonly fingerprint: string }
interface Storage { planId: string; fingerprint: string; files: readonly RelocationStorageFile[]; roots: readonly RootCapability[]; active: boolean; resources: readonly RelocationCapturedResource[]; retainedSourceBytes: number; retainedBudget: bigint; volumes: readonly { area: RootCapability; bytes: bigint }[] }
const reservations = new WeakMap<object, Storage>();
const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const physical = (info: BigIntStats): { dev: string; ino: string } => ({ dev: String(info.dev), ino: String(info.ino) });
const key = (resource: { dev: string; ino: string }): string => `${resource.dev}:${resource.ino}`;
const exists = async (absolute: string): Promise<BigIntStats | null> => { try { return await lstat(absolute, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
async function ownedDirectory(absolute: string, create: boolean): Promise<RootCapability> {
  if (!path.isAbsolute(absolute) || path.resolve(absolute) !== absolute) return relocationFail('OUT_OF_ROOT');
  if (create) await mkdir(absolute, { mode: 0o700, recursive: true });
  const info = await lstat(absolute, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute || (info.mode & 0o7777n) !== 0o700n
    || typeof process.getuid !== 'function' || typeof process.getgid !== 'function' || info.uid !== BigInt(process.getuid()) || info.gid !== BigInt(process.getgid())) return relocationFail('UNQUALIFIED');
  return Object.freeze({ id: randomUUID(), path: absolute, ...physical(info), authorized: true, label: '本域私有保全材料' });
}
export async function observeRelocationMaterialUsage(roots: readonly RootCapability[], options: RelocationIoOptions): Promise<number> {
  const pending = [...new Set(roots.map(root => root.path))], files = new Set<string>(); let bytes = 0, entries = 0;
  while (pending.length) {
    checkRelocationIo(options); const absolute = pending.pop()!, directory = await opendir(absolute);
    for await (const entry of directory) {
      checkRelocationIo(options);
      if (++entries > dto.LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes) return relocationFail('OVER_BUDGET');
      const child = path.join(absolute, entry.name), info = await lstat(child, { bigint: true });
      if (info.isSymbolicLink() || typeof process.getuid !== 'function' || info.uid !== BigInt(process.getuid())) return relocationFail('UNQUALIFIED');
      if (info.isDirectory()) { if ((info.mode & 0o7777n) !== 0o700n) return relocationFail('UNQUALIFIED'); pending.push(child); }
      else if (info.isFile()) { const identity = key(physical(info)); if (!files.has(identity)) { files.add(identity); bytes += Number(info.size); } }
      else return relocationFail('UNQUALIFIED');
      if (!Number.isSafeInteger(bytes) || bytes > dto.LOCAL_RELOCATION_PLAN_BUDGET.retainedMaterialsBytes) return relocationFail('OVER_BUDGET');
    }
  }
  return bytes;
}
/** 私有目录、实际全材料用量及每实际卷可用空间在源修改前完整预留；不删除旧材料腾空间。 */
export async function prepareRelocationStorage(input: { planId: string; resources: readonly RelocationCapturedResource[]; privateDirectory: string;
  libraryRoots: readonly RootCapability[]; retainedSourceBytes?: number } & RelocationIoOptions): Promise<RelocationStorageReservation> {
  checkRelocationIo(input);
  if (!dto.isCollectionId(input.planId) || !input.resources.length || input.resources.length > dto.LOCAL_RELOCATION_PLAN_BUDGET.closedResources
    || input.resources.reduce((total, resource) => total + resource.sourceObservation.bytes, 0) > dto.LOCAL_RELOCATION_PLAN_BUDGET.planFullSourceBytes) return relocationFail('OVER_BUDGET');
  const retainedSourceBytes = input.retainedSourceBytes ?? 0;
  if (!Number.isSafeInteger(retainedSourceBytes) || retainedSourceBytes < 0) return relocationFail('OVER_BUDGET');
  const preferred = await ownedDirectory(input.privateDirectory, true), areas = new Map<string, RootCapability>();
  const areaFor = async (root: RootCapability): Promise<RootCapability> => {
    let absolute = preferred.dev === root.dev ? preferred.path : path.join(path.dirname(root.path), '.musicbridge-relocation');
    if (input.libraryRoots.some(library => inside(library.path, absolute))) return relocationFail('UNQUALIFIED');
    const prior = areas.get(absolute); if (prior) return prior;
    const area = absolute === preferred.path ? preferred : await ownedDirectory(absolute, true);
    if (area.dev !== root.dev) return relocationFail('ROOT_IDENTITY_UNPROVEN'); areas.set(absolute, area); return area;
  };
  const prepared: { resource: RelocationCapturedResource; source: RootCapability; target: RootCapability }[] = [];
  for (const resource of input.resources) {
    await assertRelocationRootIdentity(resource.sourceRoot, resource.sourceIdentity, input); await assertRelocationRootIdentity(resource.targetRoot, resource.targetIdentity, input);
    if (resource.sourceObservation.physical.dev !== (resource.sourceAbsent ? resource.targetRoot.dev : resource.sourceRoot.dev)) return relocationFail('ROOT_IDENTITY_UNPROVEN');
    prepared.push({ resource, source: await areaFor(resource.sourceRoot), target: await areaFor(resource.targetRoot) });
  }
  const byVolume = new Map<string, { area: RootCapability; bytes: bigint }>(); let extraRetained = BigInt(retainedSourceBytes);
  for (const { resource, source, target } of prepared) {
    const action = resource.frozen.action, sourceBytes = BigInt(resource.sourceObservation.bytes), afterBytes = BigInt(resource.frozen.after.bytes);
    const sourceAllocation = action === 'move' ? sourceBytes : 0n, targetAllocation = action === 'copy-retain' || action === 'rewrite-reference' ? afterBytes : 0n;
    if (action === 'move' && !sameRelocationStorage(resource.sourceIdentity, resource.targetIdentity)) return relocationFail('ROOT_CHANGED');
    for (const [area, amount] of [[source, sourceAllocation], [target, targetAllocation]] as const) {
      const previous = byVolume.get(area.dev) ?? { area, bytes: 0n }; previous.bytes += amount; byVolume.set(area.dev, previous);
    }
    extraRetained += action === 'move' ? sourceBytes * 2n : action === 'retain' ? 0n : sourceBytes + targetAllocation;
  }
  const usage = await observeRelocationMaterialUsage([...areas.values()], input);
  if (BigInt(usage) + extraRetained > BigInt(dto.LOCAL_RELOCATION_PLAN_BUDGET.retainedMaterialsBytes)) return relocationFail('OVER_BUDGET');
  for (const { area, bytes } of byVolume.values()) {
    const space = await statfs(area.path, { bigint: true });
    if (space.bavail < 0n || space.bsize <= 0n) return relocationFail('SPACE_UNVERIFIED');
    if (space.bavail * space.bsize < bytes + BigInt(dto.LOCAL_RELOCATION_PLAN_BUDGET.hashChunkBytes)) return relocationFail('SPACE_INSUFFICIENT');
  }
  const planRoots = new Map<string, RootCapability>();
  for (const area of areas.values()) {
    const absolute = path.join(area.path, input.planId); await mkdir(absolute, { mode: 0o700 });
    planRoots.set(area.path, await ownedDirectory(absolute, false));
  }
  const files: RelocationStorageFile[] = prepared.map(({ resource, source, target }) => ({ resourceId: resource.frozen.resourceId,
    sourcePrivateRoot: planRoots.get(source.path)!, targetPrivateRoot: planRoots.get(target.path)!,
    backup: `${resource.frozen.resourceId}.backup`, quarantine: `${resource.frozen.resourceId}.capture`, stage: `${resource.frozen.resourceId}.stage` }));
  const metadata = { planId: input.planId, files, usage, retainedSourceBytes, reservedByVolume: [...byVolume].map(([dev, value]) => ({ dev, bytes: String(value.bytes) })) };
  const fingerprint = relocationHash(metadata), reservation = Object.freeze({ planId: input.planId, fingerprint }) as unknown as RelocationStorageReservation;
  reservations.set(reservation, { planId: input.planId, fingerprint, files: Object.freeze(files), roots: Object.freeze([...areas.values()]), active: true,
    resources: input.resources, retainedSourceBytes, retainedBudget: extraRetained, volumes: [...byVolume.values()] }); return reservation;
}
/** READY之后空间可能变化；授权执行前再次核实际保全用量与可用空间。 */
export async function verifyRelocationStorage(reservation: RelocationStorageReservation, options: RelocationIoOptions = {}): Promise<void> {
  const value = reservations.get(reservation); if (!value?.active) return relocationFail('UNQUALIFIED');
  if (BigInt(await observeRelocationMaterialUsage(value.roots, options)) + value.retainedBudget > BigInt(dto.LOCAL_RELOCATION_PLAN_BUDGET.retainedMaterialsBytes)) return relocationFail('OVER_BUDGET');
  for (const { area, bytes } of value.volumes) {
    checkRelocationIo(options); const space = await statfs(area.path, { bigint: true });
    if (space.bavail < 0n || space.bsize <= 0n) return relocationFail('SPACE_UNVERIFIED');
    if (space.bavail * space.bsize < bytes + BigInt(dto.LOCAL_RELOCATION_PLAN_BUDGET.hashChunkBytes)) return relocationFail('SPACE_INSUFFICIENT');
  }
}
export function relocationStorageFiles(reservation: RelocationStorageReservation): readonly RelocationStorageFile[] {
  const value = reservations.get(reservation); if (!value?.active || value.planId !== reservation.planId || value.fingerprint !== reservation.fingerprint) return relocationFail('UNQUALIFIED'); return value.files;
}
export function releaseRelocationStorage(reservation: RelocationStorageReservation): void {
  const value = reservations.get(reservation); if (!value?.active) return relocationFail('UNQUALIFIED'); value.active = false;
}
export interface RelocationOwnedPublicationFile {
  capture: RelocationCapturedResource; storage: RelocationStorageFile; source: RelocationPathObservation; target: RelocationPathObservation;
  sourceHandle: FileHandle; targetHandle: FileHandle | null; backupHandle: FileHandle | null; sourcePrivate: RelocationPathObservation; targetPrivate: RelocationPathObservation;
  quarantine: RelocationPathObservation; mutationIntent: boolean; captured: boolean; installed: boolean; registered: boolean; sourceRetained: boolean; targetObservation: RelocationFileObservation | null;
}
type File = RelocationOwnedPublicationFile;
export interface RelocationPublishedResource { operationId: string; resourceId: string; capture: RelocationCapturedResource; observation: RelocationFileObservation; sourceRetained: boolean }
export interface RelocationPublicationInput {
  resources: readonly RelocationCapturedResource[]; reservation: RelocationStorageReservation; binding: SourceNamespaceOriginBinding; signal: AbortSignal; deadlineAt: number;
  assertCurrent(): void;
  phase(fact: RelocationPublisherFact): void;
  verifyProtection(claims: PhysicalWriteClaims, sources: readonly PublicationSource[], namespace: (source: PublicationSource) => SourceNamespaceHeldObservation | undefined): Promise<void>;
  prepare(files: readonly RelocationPublishedResource[], access: RelocationReadAccess): Promise<unknown>;
  commit(files: readonly RelocationPublishedResource[], access: RelocationReadAccess, prepared: unknown): void;
}
export class RelocationPublicationRecoveryRequired extends Error {
  constructor(readonly claims: PhysicalWriteClaims | null, readonly namespace: { token: SourceNamespaceWriteToken | import('../stream/source-namespace-claims.js').SourceNamespaceRecoveryToken; scope: SourceNamespaceHeldScope } | null,
    readonly files: readonly File[], readonly handles: readonly FileHandle[], readonly issue: string, cause?: unknown) {
    super('真实文件发布或收尾结果未知；材料与保护保留，需要新具体计划对账。', { cause });
  }
}
async function copyWhole(source: FileHandle, target: FileHandle, bytes: number, options: RelocationIoOptions): Promise<void> {
  const buffer = Buffer.alloc(dto.LOCAL_RELOCATION_PLAN_BUDGET.hashChunkBytes); let position = 0;
  while (position < bytes) {
    checkRelocationIo(options); const read = await source.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
    if (!read.bytesRead) return relocationFail('SOURCE_CHANGED');
    let written = 0;
    while (written < read.bytesRead) { checkRelocationIo(options); const chunk = await target.write(buffer, written, read.bytesRead - written, position + written);
      if (!chunk.bytesWritten) return relocationFail('IO_FAILED'); written += chunk.bytesWritten; }
    position += read.bytesRead;
  }
  await target.truncate(bytes); await target.sync(); checkRelocationIo(options);
}
/** 单计划/单I/O，完整资源先持有真namespace+physical claims；没有global原子或quiet伪回执。 */
export async function publishRelocation(input: RelocationPublicationInput): Promise<readonly RelocationPublishedResource[]> {
  const storage = reservations.get(input.reservation);
  if (!storage?.active || storage.planId !== input.binding.originPlanId || input.resources !== storage.resources) return relocationFail('UNQUALIFIED');
  const files: File[] = [], handles: FileHandle[] = [], directories = new Map<string, FileHandle>();
  let claims: PhysicalWriteClaims | null = null, namespace: { token: SourceNamespaceWriteToken; scope: SourceNamespaceHeldScope } | null = null, access: RelocationReadAccess | null = null;
  let unknown = false;
  const check = (): void => { input.assertCurrent(); checkRelocationIo(input); if (namespace) assertSourceNamespaceHeld(namespace.token, namespace.scope); };
  const keep = (handle: FileHandle): FileHandle => { if (!handles.includes(handle)) handles.push(handle); return handle; };
  const directory = async (absolute: string): Promise<FileHandle> => {
    const prior = directories.get(absolute); if (prior) return prior;
    const handle = keep(await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)); directories.set(absolute, handle); return handle;
  };
  const phase = (file: File, value: dto.LocalRelocationPlanPhase, quiet = false): void => {
    input.phase({ operationId: file.capture.frozen.operationIds[0]!, resourceId: file.capture.frozen.resourceId, phase: value,
      sourceObservation: file.capture.sourceObservation, targetObservation: file.targetObservation, stage: file.targetPrivate.absolute,
      quarantine: file.quarantine.absolute, retained: file.sourcePrivate.absolute, quiet });
  };
  try {
    check(); await verifyRelocationStorage(input.reservation, input); const operations: SourceNamespaceOperation[] = [];
    for (const capture of input.resources) {
      check(); const saved = storage.files.find(value => value.resourceId === capture.frozen.resourceId)!;
      if (!saved) return relocationFail('CLOSURE_INCOMPLETE');
      const source = await captureRelocationPath(capture.sourceRoot, capture.frozen.source.relative), target = await captureRelocationPath(capture.targetRoot, capture.frozen.target.relative);
      const sourcePrivate = await captureRelocationPath(saved.sourcePrivateRoot, saved.backup), targetPrivate = await captureRelocationPath(saved.targetPrivateRoot, saved.stage), quarantine = await captureRelocationPath(saved.sourcePrivateRoot, saved.quarantine);
      for (const observed of [source, target, sourcePrivate, targetPrivate, quarantine]) {
        for (const ancestor of observed.ancestors) await directory(ancestor.absolute);
        const operationId = capture.frozen.operationIds[0]!;
        if (!operations.some(value => value.operationId === operationId && value.name.absolute === observed.absolute)) operations.push({ operationId, name: observed.namespace });
      }
      if (capture.sourceAbsent && await exists(source.absolute)) return relocationFail('SOURCE_CHANGED');
      const sourceHandle = keep(await open(capture.sourceAbsent ? target.absolute : source.absolute, constants.O_RDONLY | constants.O_NOFOLLOW));
      const file: File = { capture, storage: saved, source, target, sourceHandle, targetHandle: null, backupHandle: null, sourcePrivate, targetPrivate, quarantine,
        mutationIntent: false, captured: false, installed: false, registered: false, sourceRetained: !capture.sourceAbsent && capture.frozen.action !== 'move', targetObservation: null };
      const existing = await exists(target.absolute);
      if (capture.frozen.action === 'retain') {
        if (!existing || existing.isSymbolicLink() || !capture.targetObservation) return relocationFail('TARGET_CHANGED');
        file.targetHandle = source.absolute === target.absolute ? sourceHandle : keep(await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW));
      } else if (existing && !(capture.frozen.action === 'move' && existing.dev.toString() === capture.sourceObservation.physical.dev && existing.ino.toString() === capture.sourceObservation.physical.ino && existing.nlink === 1n)) return relocationFail('COLLISION');
      if (await exists(sourcePrivate.absolute) || await exists(targetPrivate.absolute) || await exists(quarantine.absolute)) return relocationFail('COLLISION');
      files.push(file);
    }
    const scope: SourceNamespaceHeldScope = { datasetId: input.binding.datasetId, planId: input.binding.originPlanId, originBinding: input.binding, operations };
    namespace = { token: await acquireSourceNamespaceWrite({ ...input.binding, operations }), scope };
    const resources = await Promise.all(handles.map(async handle => physical(await handle.stat({ bigint: true }))));
    const unique = [...new Map(resources.map(resource => [key(resource), resource])).values()];
    if (unique.length + new Set(operations.flatMap(value => value.name.resources.map(resource => `${resource.dev}\0${resource.absolute}`))).size > 2048) return relocationFail('OVER_BUDGET');
    claims = await acquirePhysicalWriteClaims(unique); registerPhysicalWriteClaimDescriptors(claims, handles); check();
    const namespaceFor = (source: PublicationSource): SourceNamespaceHeldObservation | undefined => {
      const absolute = path.join(source.root.path, source.relative), operation = operations.find(value => value.name.absolute === absolute);
      return operation && namespace ? { token: namespace.token, datasetId: scope.datasetId, planId: scope.planId, originBinding: scope.originBinding, operationId: operation.operationId } : undefined;
    };
    for (const file of files) {
      await verifyRelocationPath(file.source); await verifyRelocationPath(file.target);
      await assertRelocationRootIdentity(file.capture.sourceRoot, file.capture.sourceIdentity, input); await assertRelocationRootIdentity(file.capture.targetRoot, file.capture.targetIdentity, input);
      const before = await observeRelocationFile(file.sourceHandle, input);
      if (relocationHash(before) !== relocationHash(file.capture.sourceObservation)) return relocationFail('SOURCE_CHANGED');
      if (!sameSourceFileAttributes(await observeSourceFileAttributes(file.capture.sourceAbsent ? file.target.absolute : file.source.absolute, file.sourceHandle), file.capture.attributes)) return relocationFail('UNQUALIFIED');
      phase(file, 'RESERVED'); phase(file, 'SOURCE_VERIFIED');
    }
    await input.verifyProtection(claims, files.map(file => ({ root: file.capture.sourceAbsent ? file.capture.targetRoot : file.capture.sourceRoot,
      relative: file.capture.sourceAbsent ? file.capture.frozen.target.relative : file.capture.frozen.source.relative, expectedSignature: file.capture.sourceObservation.signature })), namespaceFor); check();
    for (const file of files) {
      check(); const action = file.capture.frozen.action;
      if (action === 'move') {
        file.backupHandle = keep(await open(file.sourcePrivate.absolute, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        claims = await transferPhysicalWriteClaims(claims, [physical(await file.backupHandle.stat({ bigint: true }))], handles);
        await copyWhole(file.sourceHandle, file.backupHandle, file.capture.sourceObservation.bytes, input);
        assertSameRelocationBytes(file.capture.sourceObservation, await observeRelocationFile(file.backupHandle, input));
      } else if (action === 'copy-retain' || action === 'rewrite-reference') {
        file.targetHandle = keep(await open(file.targetPrivate.absolute, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        claims = await transferPhysicalWriteClaims(claims, [physical(await file.targetHandle.stat({ bigint: true }))], handles);
        let original = file.sourceHandle, bytes = file.capture.sourceObservation.bytes;
        if (action === 'rewrite-reference') {
          const material = file.capture.rewriteMaterial; if (!material) return relocationFail('CLOSURE_INCOMPLETE');
          original = keep(await open(material.path, constants.O_RDONLY | constants.O_NOFOLLOW)); const info = await original.stat({ bigint: true });
          claims = await transferPhysicalWriteClaims(claims, [physical(info)], handles);
          const observed = await observeRelocationFile(original, input); if (observed.sha256 !== material.sha256 || observed.bytes !== material.bytes) return relocationFail('SOURCE_CHANGED'); bytes = material.bytes;
        }
        await copyWhole(original, file.targetHandle, bytes, input); await file.targetHandle.chmod(Number(file.capture.attributes.mode)); await file.targetHandle.sync();
        const staged = await observeRelocationFile(file.targetHandle, input);
        if (staged.sha256 !== file.capture.frozen.after.sha256 || String(staged.bytes) !== file.capture.frozen.after.bytes) return relocationFail('VERIFY_FAILED');
        if (!sameSourceFileAttributes(await observeSourceFileAttributes(file.targetPrivate.absolute, file.targetHandle), file.capture.attributes)) return relocationFail('UNQUALIFIED');
        file.targetObservation = staged; // 真stage inode/birth在安装意图前持久；恢复不能仅凭相同字节认领外部副本。
        phase(file, 'TARGET_STAGED'); phase(file, 'TARGET_SYNCED');
      }
      await verifyRelocationPath(file.source); await verifyRelocationPath(file.target); check();
      if (file.capture.sourceAbsent && await exists(file.source.absolute)) return relocationFail('SOURCE_CHANGED');
      if (relocationHash(await observeRelocationFile(file.sourceHandle, input)) !== relocationHash(file.capture.sourceObservation)) return relocationFail('SOURCE_CHANGED');
      if (action === 'move') {
        phase(file, 'SOURCE_CAPTURED'); file.mutationIntent = true; // durable意图先行，名字缺失窗口不是原子提交。
        await rename(file.source.absolute, file.quarantine.absolute); file.captured = true;
        await (await directory(file.source.parent)).sync(); await (await directory(file.quarantine.parent)).sync();
        const isolated = keep(await open(file.quarantine.absolute, constants.O_RDONLY | constants.O_NOFOLLOW));
        claims = await transferPhysicalWriteClaims(claims, [physical(await isolated.stat({ bigint: true }))], handles);
        const captured = await observeRelocationFile(isolated, input);
        if (captured.sha256 !== file.capture.sourceObservation.sha256 || captured.bytes !== file.capture.sourceObservation.bytes
            || key(captured.physical) !== key(file.capture.sourceObservation.physical) || captured.birthtimeNs !== file.capture.sourceObservation.birthtimeNs) return relocationFail('SOURCE_CHANGED');
        if (await exists(file.target.absolute)) return relocationFail('COLLISION');
        await link(file.quarantine.absolute, file.target.absolute); file.installed = true;
        await (await directory(file.target.parent)).sync(); await unlink(file.quarantine.absolute); await (await directory(file.quarantine.parent)).sync();
        file.targetHandle = file.sourceHandle;
      } else if (action !== 'retain') {
        if (await exists(file.target.absolute)) return relocationFail('COLLISION');
        phase(file, 'TARGET_INSTALLED'); file.mutationIntent = true; await link(file.targetPrivate.absolute, file.target.absolute); file.installed = true;
        await (await directory(file.target.parent)).sync(); await unlink(file.targetPrivate.absolute); await (await directory(file.targetPrivate.parent)).sync();
      }
      phase(file, 'TARGET_INSTALLED');
      const final = keep(await open(file.target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW));
      claims = await transferPhysicalWriteClaims(claims, [physical(await final.stat({ bigint: true }))], handles);
      const observed = await observeRelocationFile(final, input), named = await lstat(file.target.absolute, { bigint: true });
      if (observed.sha256 !== file.capture.frozen.after.sha256 || String(observed.bytes) !== file.capture.frozen.after.bytes
          || named.isSymbolicLink() || relocationSignature(named) !== observed.signature || String(named.birthtimeNs) !== observed.birthtimeNs) return relocationFail('VERIFY_FAILED');
      if (!sameSourceFileAttributes(await observeSourceFileAttributes(file.target.absolute, final), file.capture.attributes)) return relocationFail('UNQUALIFIED');
      file.targetHandle = final; file.targetObservation = observed; await verifyRelocationPath(file.target); phase(file, 'VERIFIED_TARGET');
    }
    check();
    const targets: RelocationReadTarget[] = files.map(file => ({ operationId: file.capture.frozen.operationIds[0]!, resourceId: file.capture.frozen.resourceId,
      path: file.target, handle: file.targetHandle!, observation: file.targetObservation! }));
    access = await createRelocationReadAccess(targets, claims!, namespace!.token, namespace!.scope, input.signal, input.deadlineAt);
    const published: RelocationPublishedResource[] = files.map(file => ({ operationId: file.capture.frozen.operationIds[0]!, resourceId: file.capture.frozen.resourceId,
      capture: file.capture, observation: file.targetObservation!, sourceRetained: file.sourceRetained }));
    const prepared = await input.prepare(published, access); check();
    await input.verifyProtection(claims!, files.map(file => ({ root: file.capture.targetRoot, relative: file.capture.frozen.target.relative, expectedSignature: file.targetObservation!.signature })), namespaceFor);
    for (const file of files) {
      await verifyRelocationPath(file.target); if (relocationHash(await observeRelocationFile(file.targetHandle!, input)) !== relocationHash(file.targetObservation)) return relocationFail('TARGET_CHANGED');
      if (file.sourceRetained && relocationHash(await observeRelocationFile(file.sourceHandle, input)) !== relocationHash(file.capture.sourceObservation)) return relocationFail('SOURCE_CHANGED');
    }
    check(); input.commit(published, access, prepared);
    for (const file of files) { file.registered = true; phase(file, 'REGISTERED'); if (file.sourceRetained) phase(file, 'SOURCE_RETAINED'); }
    revokeRelocationReadAccess(access); access = null;
    return Object.freeze(published);
  } catch (error) {
    unknown = files.some(file => file.mutationIntent || file.captured || file.installed || file.registered);
    if (unknown) {
      claims?.retain(); if (namespace) retainSourceNamespaceWrite(namespace.token);
      for (const file of files) try { phase(file, 'UNKNOWN'); } catch { /* 最后durable意图仍保留，不伪造回滚。 */ }
      throw new RelocationPublicationRecoveryRequired(claims, namespace, files, handles, 'RECOVERY_REQUIRED', error);
    }
    throw error;
  } finally {
    if (!unknown) {
      try {
        if (access) revokeRelocationReadAccess(access);
        if (claims) await closePhysicalWriteClaimDescriptors(claims);
        else { const closed = await Promise.allSettled(handles.map(handle => handle.close())); if (closed.some(result => result.status === 'rejected') || handles.some(handle => handle.fd !== -1)) throw new Error('实际FD关闭未核实。'); }
        for (const file of files) phase(file, 'TERMINAL', true);
        await claims?.release(); if (namespace) await releaseSourceNamespaceWrite(namespace.token, namespace.token.operationIds);
        releaseRelocationStorage(input.reservation);
      } catch (error) {
        const retained = claims?.state === 'released' ? null : claims; retained?.retain(); if (namespace) retainSourceNamespaceWrite(namespace.token);
        throw new RelocationPublicationRecoveryRequired(retained, namespace, files, handles, 'RECOVERY_REQUIRED', error);
      }
    }
  }
}
