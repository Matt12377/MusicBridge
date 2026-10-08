import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import { readonlySourceCandidateMetadata, withCheckedReadonlyMetadataSource, sourceRootAvailability, SourceFileError,
  MetadataLeaseReleaseError, type RootCapability, type PublicationSource } from '../recording/source-files.js';
import { createSourceProtectionService, type SourceProtectionEvidence } from '../recording/source-protection.js';
import { PhysicalResourceBusy } from '../stream/physical-resource-locks.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { assertRelocationMainActor, type RelocationMainActor } from './source-relocation-authority.js';
import { observeSourceFileAttributes } from './source-writes-publisher.js';
import { observeRelocationRootIdentity, assertRelocationRootIdentity, sameRelocationStorage } from './source-relocation-root-identity.js';
import { captureRelocationPath, observeRelocationFile, RelocationVerificationError, type RelocationFileObservation } from './source-relocation-verify.js';
import { observeRelocationCompanions, type RelocationPrimaryFile, type RelocationDirectoryMember, type RelocationCompanionClosure } from './source-relocation-companions.js';
import { prepareRelocationStorage, relocationStorageFiles, verifyRelocationStorage, releaseRelocationStorage, publishRelocation,
  cleanupRelocationSources, holdRelocationRecoveryProtection, RelocationPublicationRecoveryRequired, type RelocationStorageReservation } from './source-relocation-publisher.js';
import { createLocalRelocationStore, appendRelocationInView } from './local-relocation-store.js';
import { relocationEvent, relocationHash, relocationCanonical, relocationPlanHash, relocationContextFingerprint, relocationRequestFingerprint,
  relocationFrozenBody, relocationFail, LocalRelocationError, relocationUnresolvedResources, type RelocationCapturedResource,
  type RelocationCatalogSnapshot, type RelocationStoredOperation, type RelocationStoredPlan, type RelocationPublisherFact } from './local-relocation-journal.js';
import type { RelocationScanMapping, PreparedRelocationReads } from './source-relocation-scan-port.js';
import { adoptRelocationRecoveryGroup, updateRelocationRecoveryFamily, relocationRecoveryGroupPlanId, retainedRelocationRecovery, relocationRecoveryChoices,
  prepareRelocationRecovery, executeRelocationRecovery, withRelocationRecoveryProtection, invalidateRelocationRecoveryPreparation,
  type RelocationRecoveryGroup, type RelocationRecoveryPreparation } from './source-relocation-recovery.js';
import { relocationRecoveryFamily, relocationRecoveryFingerprint } from './local-relocation-journal.js';

interface Options { repository: CollectionRepository; datasetId: string; ownerEpoch?: string; assertCurrent(): void;
  assertRecoveryCurrent?(): void; beforeMedia?(): Promise<void>; now?: () => number }
interface Choice { view: dto.LocalRelocationTargetChoice; root: RootCapability; relativeDirectory: string; fileRelative: string | null;
  identity: Awaited<ReturnType<typeof observeRelocationRootIdentity>>; actor: RelocationMainActor }
interface Runtime { resources: RelocationCapturedResource[]; storage: RelocationStorageReservation | null; primaries: RelocationPrimaryFile[];
  members: RelocationDirectoryMember[]; closure: RelocationCompanionClosure; rootRelink: { before: dto.LibraryRoot; after: dto.LibraryRoot } | null;
  protectionFingerprint: string; protectionStorageFingerprint: string; reservationFingerprint: string; recovery: RelocationRecoveryPreparation | null }
interface Running { controller: AbortController; done: Promise<void>; mutated: boolean }
const zeroHash = '0'.repeat(64), domain = dto.LOCAL_RELOCATION_PLAN_DOMAIN;
const same = (a: unknown, b: unknown): boolean => relocationCanonical(a) === relocationCanonical(b);
const inside = (root: string, selected: string): boolean => { const relative = path.relative(root, selected); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const terminal = new Set<dto.LocalRelocationPlanState>(['COMPLETED', 'SOURCE_RETAINED', 'CANCELLED', 'FAILED', 'BLOCKED']);
function codeOf(error: unknown): dto.LocalRelocationPlanIssueCode {
  if (error instanceof LocalRelocationError) return error.code;
  if (error instanceof PhysicalResourceBusy) return 'LEASE_ACTIVE';
  if (error instanceof MetadataLeaseReleaseError || error instanceof LocalFactsCommitFatal || error instanceof RelocationPublicationRecoveryRequired) return 'RECOVERY_REQUIRED';
  if (error instanceof SourceFileError) return error.code === 'REVOKED' ? 'ROOT_REVOKED' : error.code === 'SOURCE_ROOT_OFFLINE' ? 'ROOT_OFFLINE'
    : error.code === 'CONTENT_CHANGED' ? 'SOURCE_CHANGED' : error.code === 'CANCELLED' ? 'CANCELLED' : 'IO_FAILED';
  if (error instanceof RelocationVerificationError) {
    if (error.issue === 'CONTENT_CHANGED') return 'SOURCE_CHANGED';
    if (error.issue === 'SOURCE_UNQUALIFIED') return 'UNSUPPORTED_SOURCE';
    if (error.issue === 'FULL_VERIFY_FAILED') return 'VERIFY_FAILED';
    if ((dto.LOCAL_RELOCATION_PLAN_ISSUE_CODES as readonly string[]).includes(error.issue)) return error.issue as dto.LocalRelocationPlanIssueCode;
  }
  if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return 'COLLISION';
  return 'IO_FAILED';
}
function issue(code: dto.LocalRelocationPlanIssueCode): dto.LocalRelocationPlanIssue {
  return { code, label: `位置操作尚未完成：${code}。`, retry: code === 'COMMAND_UNKNOWN' ? 'query-original' : code === 'RECOVERY_REQUIRED' ? 'new-specific-plan'
    : ['INVALID_REQUEST', 'OVER_BUDGET', 'GRANT_INVALID', 'GRANT_CONSUMED'].includes(code) ? 'never' : 'repreview', operationId: null, resourceId: null };
}
const unavailableCleanup = (): dto.LocalRelocationPlanCleanupView => ({ state: 'unavailable', verifiedTargetFingerprint: null, sourceResourceIds: [], issue: null });
/** 原Owner内唯一受理/journal；Main只提供真实端口和单次grant，不另设持久Outbox。 */
export function createLocalRelocationService(options: Options) {
  const repository = options.repository, catalog = repository.localCatalog, now = options.now ?? Date.now, ownerEpoch = options.ownerEpoch ?? randomUUID();
  const baseDirectory = repository.privateSourceWritesDirectory(), directory = baseDirectory ? path.join(path.dirname(baseDirectory), 'local-relocation') : null;
  const store = createLocalRelocationStore(catalog, now), key = randomBytes(32), choices = new Map<string, Choice>(), runtimes = new Map<string, Runtime>();
  const grants = new Map<string, { challenge: dto.LocalRelocationMainChallenge; actor: RelocationMainActor; consumed: boolean }>();
  const runs = new Map<string, Running>(), pending = new Set<Promise<void>>(), uncertain = new Map<string, RelocationPublicationRecoveryRequired>();
  const recoveryGroups = new Map<string, RelocationRecoveryGroup>();
  let closing = false, fatal: unknown, preparation: Promise<void> | undefined, prepared = false, qualified: string | null = null, blockedRecovery = false, closePromise: Promise<void> | undefined;
  const check = (): void => { options.assertCurrent(); if (closing || fatal || !prepared) return relocationFail('DRAINING'); };
  const protection = createSourceProtectionService({ store: repository.sourceProtection, datasetId: options.datasetId, assertCurrent: options.assertCurrent, sourceWrites: true });
  const policy = (): dto.LocalRelocationPlanPolicy => store.policy(options.datasetId);
  function writingPolicy(expected?: string, recovery = false): dto.LocalRelocationPlanPolicy {
    const value = policy(); if (!value.enabled || value.draining) return relocationFail(value.draining ? 'DRAINING' : 'POLICY_DISABLED');
    if (expected !== undefined && expected !== value.revision) return relocationFail('REVISION_CONFLICT');
    if (!qualified || blockedRecovery && !recovery) return relocationFail(blockedRecovery ? 'RECOVERY_REQUIRED' : 'UNQUALIFIED'); return value;
  }
  function capture<C extends dto.LocalRelocationPlanCommand>(command: C, input: unknown): dto.LocalRelocationPlanCommandPayloads[C] {
    check(); const value = dto.localRelocationPlanCommandSnapshot(command, input);
    if (value.datasetId !== options.datasetId) return relocationFail('INVALID_REQUEST'); return value;
  }
  const baseEvent = (planId: string | null) => ({ version: 1 as const, eventId: randomUUID(), datasetId: options.datasetId, planId, occurredAt: new Date(now()).toISOString() });
  function receipt<C extends dto.LocalRelocationPlanReceiptCommand>(command: C, request: dto.LocalRelocationPlanCommandPayloads[C], plan: dto.LocalRelocationPlan | null,
    rejected?: dto.LocalRelocationPlanIssueCode, newPolicy: dto.LocalRelocationPlanPolicy | null = null): dto.LocalRelocationPlanReceipt {
    return { datasetId: options.datasetId, commandId: request.commandId, command, requestFingerprint: relocationRequestFingerprint(command, request),
      planId: plan?.planId ?? null, jobId: plan?.jobId ?? null, outcome: rejected ? 'rejected' : 'accepted', policy: rejected ? null : newPolicy, issue: rejected ? issue(rejected) : null };
  }
  function persistReceipt<C extends dto.LocalRelocationPlanReceiptCommand>(command: C, request: dto.LocalRelocationPlanCommandPayloads[C], value: dto.LocalRelocationPlanReceipt, header: dto.LocalRelocationPlan | null = null): void {
    store.append(relocationEvent({ ...baseEvent(value.planId), kind: 'receipt', command, request, requestFingerprint: value.requestFingerprint, receipt: value, header, ownerEpoch }));
  }
  function idle(except?: string, familyIds: readonly string[] = []): void {
    if (runs.size || store.read(view => [...view.projection.plans.values()].some(stored => stored.plan.datasetId === options.datasetId && stored.plan.planId !== except
      && !familyIds.includes(stored.plan.planId) && !terminal.has(stored.plan.state) && !['DEFERRED', 'PARTIAL'].includes(stored.plan.state)))) return relocationFail('BUSY');
  }
  async function observe(root: RootCapability, relative: string, signal: AbortSignal): Promise<{ observation: RelocationFileObservation; attributes: RelocationCapturedResource['attributes'] }> {
    const metadata = await readonlySourceCandidateMetadata(root, relative);
    return withCheckedReadonlyMetadataSource(root, relative, metadata.signature, signal, async handle => ({
      observation: await observeRelocationFile(handle, { signal }), attributes: await observeSourceFileAttributes(path.join(root.path, relative), handle),
    }));
  }
  function clearProtection(evidence: SourceProtectionEvidence): void {
    if (!evidence.complete || evidence.state !== 'CLEAR') return relocationFail(evidence.state === 'BUSY' ? 'LEASE_ACTIVE'
      : evidence.state === 'PROTECTED' ? evidence.references.some(ref => ref.kind === 'ARCHIVE') ? 'ARCHIVE_REFERENCE' : evidence.references.some(ref => ref.kind === 'PREPARED') ? 'PREPARED_REFERENCE' : 'FROZEN_REFERENCE' : 'UNKNOWN_REFERENCE');
  }
  function checkCatalog(stored: RelocationStoredPlan): void {
    for (const operation of stored.operations) if (operation.source && !same(catalog.privateRelocationSnapshot(operation.source.asset.id), operation.source)) return relocationFail('REVISION_CONFLICT');
    for (const resource of stored.resources) {
      if (!same(repository.sources.root(resource.sourceRoot.id), resource.sourceRoot) || !same(repository.sources.root(resource.targetRoot.id), resource.targetRoot)) return relocationFail('ROOT_CHANGED');
    }
  }
  function selected(selection: dto.LocalRelocationPlanSelection): RelocationCatalogSnapshot {
    const value = catalog.privateRelocationSnapshot(selection.assetId);
    if (value.asset.fileRevision !== selection.expectedFileRevision || value.asset.locationRevision !== selection.expectedLocationRevision || value.libraryRoot.revision !== selection.expectedRootRevision
      || value.asset.rootRevision !== value.libraryRoot.revision || value.asset.sourceRootId !== value.libraryRoot.sourceRootId) return relocationFail('REVISION_CONFLICT');
    return value;
  }
  function choice(choiceId: string, kind: Choice['view']['kind']): Choice {
    const value = choices.get(choiceId); if (!value || value.view.kind !== kind || Date.parse(value.view.expiresAt) <= now()) return relocationFail('STALE_VIEW');
    assertRelocationMainActor(value.actor); if (!same(repository.sources.root(value.root.id), value.root)) return relocationFail('ROOT_CHANGED'); return value;
  }
  async function targetLibrary(value: Choice): Promise<dto.LibraryRoot> {
    const prior = catalog.roots().find(root => root.sourceRootId === value.root.id);
    if (prior) return prior;
    if (catalog.roots().some(root => { const actual = repository.sources.root(root.sourceRootId); return inside(actual.path, value.root.path) || inside(value.root.path, actual.path); })) return relocationFail('SHARED_REFERENCE');
    return catalog.registerRoot({ commandId: randomUUID(), sourceRootId: value.root.id, role: 'library' });
  }
  async function build(request: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview'], planId: string, signal: AbortSignal): Promise<{ runtime: Runtime; operations: RelocationStoredOperation[]; mappings: dto.LocalRelocationRootMapping[] }> {
    const intent = request.intent; writingPolicy(undefined, intent.kind === 'recovery');
    if (intent.kind === 'recovery') {
      const family = store.read(view => structuredClone(relocationRecoveryFamily(view.projection, intent.originPlanId))), root = family[0]!;
      const held = recoveryGroups.get(root.plan.planId); if (!held || relocationRecoveryGroupPlanId(held) !== intent.originPlanId) return relocationFail('RECOVERY_REQUIRED');
      const snapshots = root.operations.map(value => catalog.privateRelocationSnapshot(value.source!.asset.id));
      const retainedSourceBytes = store.read(view => [...view.projection.retainedSources.values()].reduce((total, value) => total + value.observation.bytes, 0));
      const value = await prepareRelocationRecovery({ family, group: held, planId, intent, snapshots, retainedSourceBytes, signal, assertCurrent: options.assertCurrent });
      store.capacity(value.resources.length);
      const guard = await withRelocationRecoveryProtection(value.access, (claims, sources, namespace) => protection.inspectRetained(sources, claims, namespace)); clearProtection(guard);
      return { operations: value.operations, mappings: value.mappings, runtime: { resources: value.resources, storage: null, primaries: [], members: [],
        closure: { complete: true, companions: [], edges: value.edges, inventories: [] }, rootRelink: value.rootRelink, recovery: value, reservationFingerprint: value.reservationFingerprint,
        protectionFingerprint: guard.fingerprint, protectionStorageFingerprint: guard.storageFingerprint } };
    }
    let sources: RelocationCatalogSnapshot[], picked: Choice | null = null, targetRoot: dto.LibraryRoot | null = null, relink: Runtime['rootRelink'] = null;
    if (intent.kind === 'rename' || intent.kind === 'locate') sources = [selected(intent.target)];
    else if (intent.kind === 'move') sources = intent.targets.map(selected);
    else {
      const before = catalog.root(intent.libraryRootId); if (before.revision !== intent.expectedRootRevision) return relocationFail('REVISION_CONFLICT');
      sources = catalog.privateRelocationRootMembers(before.id); if (!sources.length) return relocationFail('CLOSURE_INCOMPLETE');
    }
    if (intent.kind !== 'rename') {
      picked = choice(intent.targetChoiceId, intent.kind === 'locate' ? 'file' : 'directory'); await assertRelocationRootIdentity(picked.root, picked.identity, { signal });
      if (intent.kind === 'locate' && intent.candidateId !== picked.view.choiceId) return relocationFail('STALE_VIEW');
      if (intent.kind === 'root-reassociate') {
        const before = sources[0]!.libraryRoot; if (picked.relativeDirectory !== '.' || picked.root.id === before.sourceRootId) return relocationFail('ROOT_CHANGED');
        relink = { before, after: { ...before, sourceRootId: picked.root.id, revision: String(BigInt(before.revision) + 1n) } }; targetRoot = relink.after;
      } else targetRoot = await targetLibrary(picked);
    }
    const primaries: RelocationPrimaryFile[] = [], operations: RelocationStoredOperation[] = [], members: RelocationDirectoryMember[] = [];
    for (const snapshot of sources) {
      const sourceRoot = repository.sources.root(snapshot.asset.sourceRootId), operationId = randomUUID(), resourceId = randomUUID();
      const destinationRoot = targetRoot ?? snapshot.libraryRoot, destinationCap = repository.sources.root(destinationRoot.sourceRootId);
      const targetRelative = intent.kind === 'rename' ? path.posix.join(path.posix.dirname(snapshot.relative), intent.newName)
        : intent.kind === 'locate' ? picked!.fileRelative! : intent.kind === 'root-reassociate' ? snapshot.relative
          : path.posix.join(picked!.relativeDirectory, path.posix.basename(snapshot.relative));
      if (sourceRoot.id === destinationCap.id && targetRelative === snapshot.relative) return relocationFail('INVALID_REQUEST');
      const sourceEndpoint: dto.LocalRelocationEndpoint = { libraryRootId: snapshot.libraryRoot.id, sourceRootId: sourceRoot.id, expectedRootRevision: snapshot.libraryRoot.revision, relative: snapshot.relative };
      const targetEndpoint: dto.LocalRelocationEndpoint = { libraryRootId: destinationRoot.id, sourceRootId: destinationCap.id, expectedRootRevision: destinationRoot.revision, relative: targetRelative };
      const operation: dto.LocalRelocationFrozenOperation = { operationId, kind: intent.kind, assetId: snapshot.asset.id, trackIds: snapshot.tracks.map(track => track.id),
        expectedFileRevision: snapshot.asset.fileRevision, expectedLocationRevision: snapshot.asset.locationRevision, source: sourceEndpoint, target: targetEndpoint, resourceIds: [resourceId] };
      const item: dto.LocalRelocationPlanItem = { operationId, assetId: snapshot.asset.id, trackIds: operation.trackIds, sourceLabel: path.posix.basename(snapshot.relative), targetLabel: path.posix.basename(targetRelative),
        expectedFileRevision: snapshot.asset.fileRevision, expectedLocationRevision: snapshot.asset.locationRevision, expectedRootRevision: snapshot.libraryRoot.revision,
        state: 'pending', phase: 'PLANNED', resourceIds: operation.resourceIds, issue: null };
      primaries.push({ operationId, resourceId, assetId: snapshot.asset.id, sourceRoot, sourceRelative: snapshot.relative, targetRoot: destinationCap, targetRelative });
      operations.push({ operation, item, source: snapshot });
      for (const member of catalog.privateRelocationDirectoryMembers(snapshot.libraryRoot.id, path.posix.dirname(snapshot.relative)))
        if (!members.some(value => value.assetId === member.asset.id)) members.push({ assetId: member.asset.id, sourceRootId: member.asset.sourceRootId, relative: member.relative });
    }
    const closure = await observeRelocationCompanions(primaries, members, { signal });
    const drafts = [...primaries.map(primary => ({ resourceId: primary.resourceId, role: 'AUDIO' as const, sourceRoot: primary.sourceRoot, sourceRelative: primary.sourceRelative,
      targetRoot: primary.targetRoot, targetRelative: primary.targetRelative, operationIds: [primary.operationId], sharedMemberIds: closure.edges.some(edge => edge.shared && edge.toResourceId === primary.resourceId)
        ? members.filter(member => member.sourceRootId === primary.sourceRoot.id && path.posix.dirname(member.relative) === path.posix.dirname(primary.sourceRelative)).map(member => member.assetId) : [],
      action: intent.kind === 'locate' || intent.kind === 'root-reassociate' ? 'retain' as const : 'copy-retain' as const, rewrittenBytes: null as Buffer | null })), ...closure.companions];
    const identities = new Map<string, Awaited<ReturnType<typeof observeRelocationRootIdentity>>>(), resources: RelocationCapturedResource[] = [], mappings: dto.LocalRelocationRootMapping[] = [];
    const rootIdentity = async (root: RootCapability) => { const prior = identities.get(root.id); if (prior) return prior; const actual = await observeRelocationRootIdentity(root, { signal }); identities.set(root.id, actual); return actual; };
    const endpointFor = (draft: typeof drafts[number], side: 'source' | 'target'): dto.LocalRelocationEndpoint => {
      const primary = operations.find(value => draft.operationIds.includes(value.operation.operationId))!.operation;
      return { ...primary[side], sourceRootId: draft[`${side}Root`].id, relative: draft[`${side}Relative`] };
    };
    for (const draft of drafts) {
      const sourceIdentity = await rootIdentity(draft.sourceRoot), targetIdentity = await rootIdentity(draft.targetRoot);
      const sourcePath = await captureRelocationPath(draft.sourceRoot, draft.sourceRelative), targetPath = await captureRelocationPath(draft.targetRoot, draft.targetRelative);
      let targetObservation: RelocationFileObservation | null = null;
      try { const named = await lstat(targetPath.absolute); if (named.isSymbolicLink()) return relocationFail('SYMLINK');
        // 原只读作者严拒非规范名字；实际FS把不同目标拼法解析为原inode时，先明确拒碰撞而不放宽旧Reader。
        if (draft.sourceRoot.id === draft.targetRoot.id && draft.sourceRelative !== draft.targetRelative && await realpath(targetPath.absolute) !== targetPath.absolute) {
          const source = await lstat(sourcePath.absolute); if (!source.isSymbolicLink() && source.dev === named.dev && source.ino === named.ino) return relocationFail('COLLISION');
        }
        targetObservation = (await observe(draft.targetRoot, draft.targetRelative, signal)).observation; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let before: Awaited<ReturnType<typeof observe>>, sourceAbsent = false;
      try { before = await observe(draft.sourceRoot, draft.sourceRelative, signal); }
      catch (error) {
        const missing = error instanceof SourceFileError && error.code === 'MISSING' || (error as NodeJS.ErrnoException).code === 'ENOENT';
        const source = operations.find(operation => operation.operation.operationId === draft.operationIds[0])?.source;
        if (!missing || draft.role !== 'AUDIO' || intent.kind !== 'locate' && intent.kind !== 'root-reassociate') throw error;
        if (!source?.catalogSha256 || !targetObservation || source.catalogSha256 !== targetObservation.sha256) return relocationFail('HASH_MISMATCH');
        const candidate = await observe(draft.targetRoot, draft.targetRelative, signal); targetObservation = candidate.observation;
        before = { observation: candidate.observation, attributes: candidate.attributes }; sourceAbsent = true;
      }
      let action: dto.LocalRelocationFrozenResource['action'] = draft.action;
      if (intent.kind === 'root-reassociate' || intent.kind === 'locate') action = draft.rewrittenBytes ? 'rewrite-reference'
        : draft.role === 'AUDIO' || targetObservation ? 'retain' : 'copy-retain';
      if (intent.kind === 'rename' && !closure.companions.some(value => value.action === 'rewrite-reference') && sameRelocationStorage(sourceIdentity, targetIdentity)) action = 'move';
      if (targetObservation && action !== 'retain' && !(action === 'move' && same(targetObservation.physical, before.observation.physical))) return relocationFail('COLLISION');
      if (action === 'retain' && (!targetObservation || targetObservation.sha256 !== before.observation.sha256 || targetObservation.bytes !== before.observation.bytes)) return relocationFail('HASH_MISMATCH');
      const after = draft.rewrittenBytes ? { sha256: createHash('sha256').update(draft.rewrittenBytes).digest('hex'), bytes: String(draft.rewrittenBytes.length) }
        : { sha256: before.observation.sha256, bytes: String(before.observation.bytes) };
      const frozen: dto.LocalRelocationFrozenResource = { resourceId: draft.resourceId, role: draft.role, operationIds: [...draft.operationIds], source: endpointFor(draft, 'source'), target: endpointFor(draft, 'target'), action,
        before: { sha256: before.observation.sha256, bytes: String(before.observation.bytes) }, after, sourceObservationFingerprint: relocationHash(before.observation),
        targetObservationFingerprint: relocationHash({ path: targetPath, observation: targetObservation }), attributesFingerprint: relocationHash(before.attributes), sharedMemberIds: [...draft.sharedMemberIds],
        transitionNames: [`${draft.resourceId}.backup`, `${draft.resourceId}.capture`, `${draft.resourceId}.stage`] };
      if (draft.role === 'AUDIO') { const snapshot = operations.find(value => value.operation.operationId === draft.operationIds[0])!.source!;
        if (snapshot.catalogSha256 !== null && snapshot.catalogSha256 !== before.observation.sha256) return relocationFail('HASH_MISMATCH'); }
      resources.push({ frozen, sourceRoot: draft.sourceRoot, targetRoot: draft.targetRoot, sourceAbsent,
        sourceObservationOrigin: sourceAbsent ? 'CANDIDATE_FD_MATCHING_CATALOG_SHA256' : 'CURRENT_SOURCE_FD', sourceObservation: before.observation, targetObservation,
        sourceIdentity, targetIdentity, attributes: before.attributes, rewriteMaterial: draft.rewrittenBytes ? { path: path.join(directory!, planId, `${draft.resourceId}.reference`), sha256: after.sha256, bytes: Number(after.bytes) } : null });
      if (!mappings.some(mapping => mapping.source.libraryRootId === frozen.source.libraryRootId && mapping.source.sourceRootId === frozen.source.sourceRootId
        && mapping.target.libraryRootId === frozen.target.libraryRootId && mapping.target.sourceRootId === frozen.target.sourceRootId)) mappings.push({ mappingId: randomUUID(), source: frozen.source, target: frozen.target,
        sourceCapabilityFingerprint: relocationHash(draft.sourceRoot), targetCapabilityFingerprint: relocationHash(draft.targetRoot), sourcePhysicalRootFingerprint: sourceIdentity.fingerprint,
        targetPhysicalRootFingerprint: targetIdentity.fingerprint, sourceAncestorFingerprint: relocationHash(sourcePath.ancestors), targetAncestorFingerprint: relocationHash(targetPath.ancestors) });
    }
    for (const operation of operations) { operation.operation.resourceIds = resources.filter(value => value.frozen.operationIds.includes(operation.operation.operationId)).map(value => value.frozen.resourceId); operation.item.resourceIds = [...operation.operation.resourceIds]; }
    if (new Set(mappings.flatMap(mapping => [`${mapping.source.libraryRootId}:${mapping.source.sourceRootId}`, `${mapping.target.libraryRootId}:${mapping.target.sourceRootId}`])).size > dto.LOCAL_RELOCATION_PLAN_BUDGET.sourceAndTargetRoots) return relocationFail('OVER_BUDGET');
    store.capacity(resources.length);
    const sourcesToProtect = resources.map(resource => ({ root: resource.sourceAbsent ? resource.targetRoot : resource.sourceRoot,
      relative: resource.sourceAbsent ? resource.frozen.target.relative : resource.frozen.source.relative, expectedSignature: resource.sourceObservation.signature }));
    const guard = await protection.inspect(sourcesToProtect); clearProtection(guard);
    const retainedSourceBytes = store.read(view => [...view.projection.retainedSources.values()].reduce((total, value) => total + value.observation.bytes, 0));
    const storage = await prepareRelocationStorage({ planId, resources, privateDirectory: directory!, libraryRoots: catalog.roots().map(root => repository.sources.root(root.sourceRootId)), retainedSourceBytes, signal });
    for (const resource of resources) { const file = relocationStorageFiles(storage).find(value => value.resourceId === resource.frozen.resourceId); if (!file) return relocationFail('CLOSURE_INCOMPLETE'); resource.storage = { ...file }; }
    // 引用稿只写入本域私有材料，不经过Renderer、Scanner表或旧音频writer。
    for (const draft of drafts.filter(value => value.rewrittenBytes)) {
      const material = resources.find(resource => resource.frozen.resourceId === draft.resourceId)!.rewriteMaterial!;
      const folder = path.dirname(material.path); await mkdir(folder, { mode: 0o700, recursive: true });
      const fd = await open(material.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fd.writeFile(draft.rewrittenBytes!); await fd.sync(); } finally { await fd.close(); }
      const parent = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
    }
    return { runtime: { resources, storage, primaries, members, closure, rootRelink: relink, protectionFingerprint: guard.fingerprint, protectionStorageFingerprint: guard.storageFingerprint,
      reservationFingerprint: storage.fingerprint, recovery: null }, operations, mappings };
  }
  function publicResource(value: RelocationCapturedResource): dto.LocalRelocationPlanResource {
    return { resourceId: value.frozen.resourceId, role: value.frozen.role, label: path.posix.basename(value.frozen.source.relative), operationIds: [...value.frozen.operationIds], bytes: value.frozen.before.bytes,
      state: 'pending', phase: 'PLANNED', verification: 'verified-source', sourceHandling: value.frozen.action === 'move' ? 'move-pending' : 'unchanged',
      contentEffect: value.frozen.action === 'rewrite-reference' ? 'reference-rewritten' : 'whole-bytes-preserved', issue: null };
  }
  function phase(planId: string, fact: RelocationPublisherFact): void {
    const saved = store.plan(options.datasetId, planId), original = saved.plan.resources.find(resource => resource.resourceId === fact.resourceId)!;
    const resource = structuredClone(original); resource.phase = fact.phase;
    if (fact.phase === 'SOURCE_VERIFIED') resource.verification = 'verified-source';
    if (['SOURCE_CAPTURED', 'TARGET_STAGED', 'TARGET_SYNCED', 'TARGET_INSTALLED'].includes(fact.phase)) resource.state = 'moving';
    if (fact.phase === 'VERIFIED_TARGET') { resource.state = 'verified'; resource.verification = 'verified-target'; }
    if (fact.phase === 'REGISTERED') { resource.state = 'registered'; resource.verification = 'verified-target'; }
    if (fact.phase === 'SOURCE_RETAINED') { resource.state = 'retained'; resource.sourceHandling = 'retained'; }
    if (fact.phase === 'SOURCE_REMOVED') { resource.state = 'cleaned'; resource.sourceHandling = 'removed'; resource.verification = 'verified-target'; }
    if (fact.phase === 'UNKNOWN') { resource.state = 'unknown'; resource.verification = 'unknown'; resource.sourceHandling = 'unknown'; resource.issue = issue('RECOVERY_REQUIRED'); }
    if (fact.phase === 'CLEANUP_REQUESTED') resource.sourceHandling = 'cleanup-eligible';
    const running = runs.get(planId); if (running && ['SOURCE_CAPTURED', 'TARGET_INSTALLED', 'SOURCE_REMOVED'].includes(fact.phase)) running.mutated = true;
    store.append(relocationEvent({ ...baseEvent(planId), kind: 'phase', fact, resource }), ['TERMINAL', 'UNKNOWN', 'SOURCE_REMOVED', 'DIRECTORY_SYNCED'].includes(fact.phase));
  }
  async function preparePlan(request: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview'], planId: string, signal: AbortSignal): Promise<void> {
    try {
      const value = await build(request, planId, signal); check(); const currentPolicy = writingPolicy(undefined, request.intent.kind === 'recovery'), saved = store.plan(options.datasetId, planId);
      const resourceClosureHash = relocationHash({ resources: value.runtime.resources.map(resource => resource.frozen), edges: value.runtime.closure.edges, inventories: value.runtime.closure.inventories });
      const body: dto.LocalRelocationFrozenBody = { version: 1, domain, createdAt: saved.plan.createdAt, intent: request.intent, operations: value.operations.map(operation => operation.operation), rootMappings: value.mappings,
        resourceClosure: { complete: true, resources: value.runtime.resources.map(resource => resource.frozen), referenceEdges: value.runtime.closure.edges, fingerprint: resourceClosureHash },
        sourceRetention: { disposition: saved.plan.sourceDisposition, cleanupRequiresNewGrant: true, resourceIds: value.runtime.resources.filter(resource => resource.frozen.action !== 'move').map(resource => resource.frozen.resourceId) },
        guards: { noOverwrite: true, preserveAudioWholeBytes: true, unknownReferences: 'BLOCK', physicalRootIdentity: 'REQUIRED', leaseProtection: 'REQUIRED', reservationFingerprint: value.runtime.reservationFingerprint } };
      const eventsBeforeReady = value.operations.length + value.mappings.length + value.runtime.resources.length + value.runtime.closure.edges.length + (value.runtime.recovery ? 1 : 0);
      const context: dto.LocalRelocationFrozenContext = { version: 1, domain, datasetId: options.datasetId, planId, viewRevision: String(BigInt(saved.plan.viewRevision) + BigInt(eventsBeforeReady) + 1n),
        policyRevision: currentPolicy.revision, ownerEpoch, targetChoiceIds: request.intent.kind === 'rename' || request.intent.kind === 'recovery' ? [] : [request.intent.targetChoiceId],
        rootObservationFingerprint: relocationHash(value.mappings), resourceObservationFingerprint: relocationHash(value.runtime.resources), protectionFingerprint: value.runtime.protectionFingerprint,
        reservationFingerprint: value.runtime.reservationFingerprint, commandFingerprint: relocationRequestFingerprint('localRelocationPlan.preview', request) };
      const frozen = dto.localRelocationFrozenPlanSnapshot(body, context);
      // 完整capture及私有材料名同样受总预算约束，不能以Hash替代输入计量。
      relocationCanonical({ body: frozen.body, context: frozen.context, captures: value.runtime.resources, storage: value.runtime.storage ? relocationStorageFiles(value.runtime.storage) : value.runtime.recovery!.origin,
        inventories: value.runtime.recovery?.inventories ?? value.runtime.closure.inventories, recoveryMaterials: value.runtime.recovery?.materialObservations ?? [], recoveryPaths: value.runtime.recovery?.pathObservations ?? [] });
      store.transaction(view => {
        if (value.runtime.recovery) appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'recovery-origin', value: value.runtime.recovery.origin }));
        value.operations.forEach((operation, index) => appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'operation', index, value: operation })));
        value.mappings.forEach((mapping, index) => appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'root-mapping', index, value: mapping })));
        value.runtime.resources.forEach((resource, index) => appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'resource', index, value: resource, resource: publicResource(resource) })));
        value.runtime.closure.edges.forEach((edge, index) => appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'reference-edge', index, value: edge })));
        const { operations: _operations, rootMappings: _mappings, resourceClosure: _closure, ...header } = frozen.body;
        appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'ready', header, closureComplete: true, closureFingerprint: resourceClosureHash,
          context: frozen.context, planHash: relocationPlanHash(frozen.body), contextFingerprint: relocationContextFingerprint(frozen.context) }));
      }); runtimes.set(planId, value.runtime);
    } catch (error) {
      const code = codeOf(error); try { store.state(options.datasetId, planId, code === 'LEASE_ACTIVE' ? 'DEFERRED' : code === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : code === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED', [issue(code)], true); } catch (persist) { fatal = persist; }
    }
  }
  function track(planId: string, task: (controller: AbortController) => Promise<void>): void {
    const controller = new AbortController(), running: Running = { controller, mutated: false, done: Promise.resolve() };
    runs.set(planId, running); const done = Promise.resolve().then(() => task(controller)).catch(error => { fatal = error; }).finally(() => {
      runs.delete(planId); pending.delete(done);
      const current = policy(); if (!runs.size && !current.enabled && current.draining) store.append(relocationEvent({ ...baseEvent(null), kind: 'policy-quiet', policy: { ...current, draining: false } }), true);
    }); running.done = done; pending.add(done); void done.catch(() => {});
  }
  function recoveryFamily(planId: string): RelocationStoredPlan[] {
    return store.read(view => structuredClone(relocationRecoveryFamily(view.projection, planId)));
  }
  function recoverableChoices(stored: RelocationStoredPlan): dto.LocalRelocationPlanRecoveryChoice[] {
    if (!stored.ready) return [];
    const family = recoveryFamily(stored.plan.planId), held = recoveryGroups.get(family[0]!.plan.planId);
    if (!held || relocationRecoveryGroupPlanId(held) !== stored.plan.planId) return [];
    return relocationRecoveryChoices(family);
  }
  function retainUnknown(planId: string, error: RelocationPublicationRecoveryRequired): void {
    uncertain.set(planId, error); blockedRecovery = true;
    const family = recoveryFamily(planId), rootId = family[0]!.plan.planId, held = recoveryGroups.get(rootId);
    if (held) updateRelocationRecoveryFamily(held, family);
    else recoveryGroups.set(rootId, adoptRelocationRecoveryGroup(family, error));
  }
  function checkRecoveryCatalog(runtime: Runtime, stored: RelocationStoredPlan): void {
    const recovery = runtime.recovery; if (!recovery || !stored.recoveryOrigin) return relocationFail('RECOVERY_REQUIRED');
    const family = recoveryFamily(stored.recoveryOrigin.originPlanId);
    if (relocationRecoveryFingerprint(family) !== recovery.origin.recoveryFingerprint) return relocationFail('STALE_VIEW');
    checkCatalog(stored);
  }
  async function executeRecovery(planId: string, commandId: string, actor: RelocationMainActor, signal: AbortSignal, runtime: Runtime): Promise<void> {
    const stored = store.plan(options.datasetId, planId), recovery = runtime.recovery!;
    try {
      await options.beforeMedia?.(); check(); assertRelocationMainActor(actor); writingPolicy(stored.plan.policyRevision, true); checkRecoveryCatalog(runtime, stored);
      store.state(options.datasetId, planId, 'RUNNING');
      const mappings: RelocationScanMapping[] = stored.operations.map(operation => {
        const audio = stored.resources.find(value => value.frozen.role === 'AUDIO' && value.frozen.operationIds.includes(operation.operation.operationId))!;
        return { operationId: operation.operation.operationId, resourceId: audio.frozen.resourceId, beforeAsset: operation.source!.asset, tracks: operation.source!.tracks,
          destination: { libraryRootId: audio.frozen.target.libraryRootId, sourceRootId: audio.frozen.target.sourceRootId, rootRevision: audio.frozen.target.expectedRootRevision, relative: audio.frozen.target.relative } };
      });
      let catalogCommitted = false;
      await executeRelocationRecovery({ access: recovery.access, signal, assertCurrent: () => { options.assertCurrent(); if (fatal) throw fatal; },
        verifyCatalog: () => {
          if (!catalogCommitted) checkRecoveryCatalog(runtime, stored);
          else for (const mapping of mappings) {
            const current = catalog.privateRelocationSnapshot(mapping.beforeAsset.id);
            if (current.relative !== mapping.destination.relative || current.asset.sourceRootId !== mapping.destination.sourceRootId
              || current.asset.locationRevision !== String(BigInt(mapping.beforeAsset.locationRevision) + 1n) || current.asset.fileRevision !== mapping.beforeAsset.fileRevision) return relocationFail('REVISION_CONFLICT');
          }
        }, phase: fact => phase(planId, fact),
        verifyProtection: async (claims, sources, namespace) => {
          const evidence = await protection.inspectHeld(sources, claims, undefined, namespace); clearProtection(evidence);
          if (evidence.storageFingerprint !== runtime.protectionStorageFingerprint) return relocationFail('UNKNOWN_REFERENCE');
        },
        prepare: (_files, access) => catalog.privateRelocationPrepareReads({ datasetId: options.datasetId, planId, planHash: stored.plan.planHash, resourceClosureHash: stored.plan.closure.fingerprint, mappings }, access, signal),
        commit: (files, access, reads) => {
          store.transaction(view => {
            const accepted = view.projection.receipts.get(commandId); if (!accepted || accepted.receipt.outcome !== 'accepted') return relocationFail('COMMAND_UNKNOWN');
            const committed = view.commitLocations({ commandId, requestFingerprint: accepted.requestFingerprint, planId, planHash: stored.plan.planHash, resourceClosureHash: stored.plan.closure.fingerprint,
              mappings, reads: reads as PreparedRelocationReads, readAccess: access, rootRelink: runtime.rootRelink,
              mappingProofs: mappings.map(mapping => { const file = files.find(value => value.resourceId === mapping.resourceId)!; return { resourceId: mapping.resourceId, sourceObservation: file.capture.sourceObservation, targetObservation: file.observation }; }) });
            if (runtime.rootRelink) appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'root-facts', beforeRoot: runtime.rootRelink.before, afterRoot: runtime.rootRelink.after, planHash: stored.plan.planHash }), true);
            for (const fact of committed.facts) appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'location-facts', fact }), true);
          }); catalogCommitted = true;
        },
        resolved: (files, family) => {
          const retained = files.filter(file => file.sourceRetained), movingAssets = new Set(mappings.map(value => value.beforeAsset.id));
          const shared = retained.some(value => value.capture.frozen.sharedMemberIds.some(assetId => !movingAssets.has(assetId)));
          const cleanup: dto.LocalRelocationPlanCleanupView = retained.length ? { state: shared ? 'blocked' : 'eligible', verifiedTargetFingerprint: relocationHash({ planId, planHash: stored.plan.planHash,
            targets: files.map(file => ({ resourceId: file.resourceId, observation: file.observation })), assets: mappings.map(value => catalog.privateRelocationSnapshot(value.beforeAsset.id)) }),
            sourceResourceIds: retained.map(value => value.resourceId), issue: shared ? issue('SHARED_REFERENCE') : null } : unavailableCleanup();
          store.transaction(view => {
            for (const ancestor of family) for (const resource of ancestor.resources) if (!ancestor.resolvedResources.has(resource.frozen.resourceId))
              appendRelocationInView(view, relocationEvent({ ...baseEvent(ancestor.plan.planId), kind: 'recovery-resolved', resourceId: resource.frozen.resourceId,
                recoveryPlanId: planId, recoveryResourceId: resource.frozen.resourceId, recoveryPlanHash: stored.plan.planHash, quiet: true }), true);
            for (const ancestor of family) appendRelocationInView(view, relocationEvent({ ...baseEvent(ancestor.plan.planId), kind: 'state', state: 'PARTIAL', issues: [],
              cleanup: ancestor.plan.cleanup, recoveryChoices: [] }), true);
            appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'state', state: retained.length ? 'SOURCE_RETAINED' : 'COMPLETED', issues: [], cleanup, recoveryChoices: [] }), true);
          });
        },
      });
      const rootId = recovery.origin.familyRootPlanId; recoveryGroups.delete(rootId);
      for (const member of recoveryFamily(planId)) uncertain.delete(member.plan.planId);
      blockedRecovery = uncertain.size !== 0; runtimes.delete(planId);
    } catch (error) {
      const code = codeOf(error);
      try {
        store.state(options.datasetId, planId, error instanceof RelocationPublicationRecoveryRequired ? 'RECOVERY_REQUIRED' : code === 'LEASE_ACTIVE' ? 'DEFERRED' : 'FAILED', [issue(code)], true);
        if (error instanceof RelocationPublicationRecoveryRequired) retainUnknown(planId, error);
      } catch (persist) { fatal = persist; }
    }
  }
  async function execute(planId: string, commandId: string, actor: RelocationMainActor, signal: AbortSignal): Promise<void> {
    const stored = store.plan(options.datasetId, planId), runtime = runtimes.get(planId); if (!runtime) return relocationFail('RECOVERY_REQUIRED');
    if (runtime.recovery) return executeRecovery(planId, commandId, actor, signal, runtime);
    const reservation = runtime.storage; if (!reservation) return relocationFail('UNQUALIFIED');
    try {
      await options.beforeMedia?.(); check(); assertRelocationMainActor(actor); writingPolicy(stored.plan.policyRevision); checkCatalog(stored);
      const closure = await observeRelocationCompanions(runtime.primaries, runtime.members, { signal });
      if (!same(closure.inventories, runtime.closure.inventories)) return relocationFail('SOURCE_CHANGED');
      await verifyRelocationStorage(reservation, { signal }); store.state(options.datasetId, planId, 'RUNNING');
      const mappings: RelocationScanMapping[] = stored.operations.map(operation => {
        const audio = stored.resources.find(resource => resource.frozen.role === 'AUDIO' && resource.frozen.operationIds.includes(operation.operation.operationId))!;
        return { operationId: operation.operation.operationId, resourceId: audio.frozen.resourceId, beforeAsset: operation.source!.asset, tracks: operation.source!.tracks,
          destination: { libraryRootId: audio.frozen.target.libraryRootId, sourceRootId: audio.frozen.target.sourceRootId, rootRevision: audio.frozen.target.expectedRootRevision, relative: audio.frozen.target.relative } };
      });
      const binding = { datasetId: options.datasetId, originPlanId: planId, planHash: stored.plan.planHash, contextFingerprint: stored.plan.contextFingerprint,
        journalSequence: stored.plan.journalSequence, projectionFingerprint: store.read(view => view.projection.fingerprint) };
      const published = await publishRelocation({ resources: runtime.resources, reservation, binding, signal, deadlineAt: Date.now() + dto.LOCAL_RELOCATION_PLAN_BUDGET.runtimeDeadlineMs,
        assertCurrent: () => { options.assertCurrent(); if (fatal) throw fatal; }, phase: fact => phase(planId, fact),
        verifyProtection: async (claims, sources, namespace) => { options.assertCurrent(); const evidence = await protection.inspectHeld(sources, claims, undefined, namespace); clearProtection(evidence);
          if (evidence.storageFingerprint !== runtime.protectionStorageFingerprint) return relocationFail('UNKNOWN_REFERENCE'); },
        prepare: async (_files, access) => catalog.privateRelocationPrepareReads({ datasetId: options.datasetId, planId, planHash: stored.plan.planHash, resourceClosureHash: stored.plan.closure.fingerprint, mappings }, access, signal),
        commit: (files, access, readTicket) => store.transaction(view => {
          const accepted = view.projection.receipts.get(commandId); if (!accepted || accepted.receipt.outcome !== 'accepted') return relocationFail('COMMAND_UNKNOWN');
          const committed = view.commitLocations({ commandId, requestFingerprint: accepted.requestFingerprint, planId, planHash: stored.plan.planHash, resourceClosureHash: stored.plan.closure.fingerprint,
            mappings, reads: readTicket as PreparedRelocationReads, readAccess: access, rootRelink: runtime.rootRelink,
            mappingProofs: mappings.map(mapping => { const file = files.find(value => value.resourceId === mapping.resourceId)!; return { resourceId: mapping.resourceId, sourceObservation: file.capture.sourceObservation, targetObservation: file.observation }; }) });
          if (runtime.rootRelink) appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'root-facts', beforeRoot: runtime.rootRelink.before, afterRoot: runtime.rootRelink.after, planHash: stored.plan.planHash }), true);
          for (const fact of committed.facts) appendRelocationInView(view, relocationEvent({ ...baseEvent(planId), kind: 'location-facts', fact }), true);
        }),
      });
      const retained = published.filter(file => file.sourceRetained && file.capture.frozen.source.relative !== file.capture.frozen.target.relative
        || file.sourceRetained && file.capture.frozen.source.sourceRootId !== file.capture.frozen.target.sourceRootId);
      const fingerprint = relocationHash({ planId, planHash: stored.plan.planHash, targets: published.map(file => ({ resourceId: file.resourceId, observation: file.observation })),
        assets: mappings.map(mapping => catalog.privateRelocationSnapshot(mapping.beforeAsset.id)) });
      const movingAssets = new Set(mappings.map(mapping => mapping.beforeAsset.id));
      const sharedReference = retained.some(file => file.capture.frozen.sharedMemberIds.some(assetId => !movingAssets.has(assetId)));
      const cleanup: dto.LocalRelocationPlanCleanupView = retained.length ? { state: sharedReference ? 'blocked' : 'eligible', verifiedTargetFingerprint: fingerprint,
        sourceResourceIds: retained.map(file => file.resourceId), issue: sharedReference ? issue('SHARED_REFERENCE') : null } : unavailableCleanup();
      store.state(options.datasetId, planId, retained.length ? 'SOURCE_RETAINED' : 'COMPLETED', [], true, cleanup);
    } catch (error) {
      const code = codeOf(error);
      try { store.state(options.datasetId, planId, code === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : code === 'LEASE_ACTIVE' ? 'DEFERRED' : code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', [issue(code)], true); } catch (persist) { fatal = persist; }
      if (error instanceof RelocationPublicationRecoveryRequired) try { retainUnknown(planId, error); } catch (retain) { fatal = retain; }
    }
  }
  function bound(request: dto.LocalRelocationPlanConfirm | dto.LocalRelocationPlanCleanup, cleanup: boolean, afterChallenge = false): RelocationStoredPlan {
    const stored = store.plan(options.datasetId, request.planId); writingPolicy(undefined, !!stored.recoveryOrigin);
    if (request.planHash !== stored.plan.planHash || request.contextFingerprint !== stored.plan.contextFingerprint) return relocationFail('HASH_MISMATCH');
    if (BigInt(stored.plan.viewRevision) !== BigInt(request.expectedViewRevision) + (afterChallenge ? 1n : 0n)) return relocationFail('STALE_VIEW');
    if (cleanup) {
      const selected = request as dto.LocalRelocationPlanCleanup;
      if (stored.plan.state !== 'SOURCE_RETAINED' || stored.plan.cleanup.state !== 'eligible' || selected.verifiedTargetFingerprint !== stored.plan.cleanup.verifiedTargetFingerprint
        || !same(selected.sourceResourceIds, stored.plan.cleanup.sourceResourceIds)) return relocationFail('CLEANUP_NOT_VERIFIED');
    } else if (stored.plan.state !== 'READY' || stored.ownerEpoch !== ownerEpoch || !runtimes.has(stored.plan.planId)) return relocationFail('RECOVERY_REQUIRED');
    writingPolicy(stored.plan.policyRevision, !!stored.recoveryOrigin); return stored;
  }
  async function challenge(request: dto.LocalRelocationPlanConfirm | dto.LocalRelocationPlanCleanup, actor: RelocationMainActor, cleanup: boolean): Promise<dto.LocalRelocationMainChallenge> {
    check(); assertRelocationMainActor(actor); const command = cleanup ? 'localRelocationPlan.cleanup' as const : 'localRelocationPlan.confirm' as const;
    if (store.read(view => view.projection.receipts.has(request.commandId) || view.projection.capabilities.has(request.commandId))) return relocationFail('COMMAND_UNKNOWN');
    const familyIds = recoveryFamily(request.planId).map(value => value.plan.planId);
    idle(request.planId, familyIds); const stored = bound(request, cleanup); if (!cleanup) {
      const runtime = runtimes.get(request.planId); if (runtime?.recovery) checkRecoveryCatalog(runtime, stored); else checkCatalog(stored);
    }
    const binding = { datasetId: options.datasetId, commandId: request.commandId, planId: request.planId, expectedViewRevision: request.expectedViewRevision, domain,
      action: cleanup ? 'cleanup' as const : 'execute' as const, planHash: request.planHash, contextFingerprint: request.contextFingerprint, policyRevision: stored.plan.policyRevision,
      requestFingerprint: relocationRequestFingerprint(command, request as never), verifiedTargetFingerprint: cleanup ? (request as dto.LocalRelocationPlanCleanup).verifiedTargetFingerprint : null,
      sourceResourceIds: cleanup ? [...(request as dto.LocalRelocationPlanCleanup).sourceResourceIds] : [], expiresAt: new Date(cleanup ? now() + 600_000 : Math.min(Date.parse(stored.plan.expiresAt), now() + 600_000)).toISOString() };
    const unsigned = { domain, action: binding.action, challengeId: randomUUID(), ownerEpoch, nonce: randomBytes(32).toString('hex'), authorityId: actor.authorityId };
    const signature = createHmac('sha256', key).update(relocationCanonical({ binding, unsigned }), 'utf8').digest('hex'), value = { ...binding, grant: { ...unsigned, signature } };
    store.append(relocationEvent({ ...baseEvent(request.planId), kind: 'capability', command, request, requestFingerprint: binding.requestFingerprint, challenge: value }));
    grants.set(unsigned.challengeId, { challenge: value, actor, consumed: false }); return structuredClone(value);
  }
  async function granted(request: dto.LocalRelocationPlanConfirm | dto.LocalRelocationPlanCleanup, grant: dto.LocalRelocationMainGrant, actor: RelocationMainActor, cleanup: boolean): Promise<dto.LocalRelocationPlanReceipt> {
    check(); assertRelocationMainActor(actor); const entry = grants.get(grant.challengeId), command = cleanup ? 'localRelocationPlan.cleanup' as const : 'localRelocationPlan.confirm' as const;
    if (!entry || entry.actor !== actor || entry.consumed || !same(entry.challenge.grant, grant) || grant.ownerEpoch !== ownerEpoch || grant.authorityId !== actor.authorityId || grant.action !== (cleanup ? 'cleanup' : 'execute')) return relocationFail(entry?.consumed ? 'GRANT_CONSUMED' : 'GRANT_INVALID');
    if (Date.parse(entry.challenge.expiresAt) <= now()) return relocationFail('GRANT_EXPIRED');
    const { grant: capturedGrant, ...binding } = entry.challenge, { signature, ...unsigned } = capturedGrant;
    const expected = createHmac('sha256', key).update(relocationCanonical({ binding, unsigned }), 'utf8').digest(), actual = Buffer.from(signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || binding.requestFingerprint !== relocationRequestFingerprint(command, request as never)) return relocationFail('GRANT_INVALID');
    idle(request.planId, recoveryFamily(request.planId).map(value => value.plan.planId)); const stored = bound(request, cleanup, true), value = receipt(command, request as never, stored.plan);
    store.transaction(view => {
      appendRelocationInView(view, relocationEvent({ ...baseEvent(request.planId), kind: 'capability-consumed', commandId: request.commandId, challengeId: grant.challengeId, requestFingerprint: value.requestFingerprint }));
      appendRelocationInView(view, relocationEvent({ ...baseEvent(request.planId), kind: 'receipt', command, request, requestFingerprint: value.requestFingerprint, receipt: value, header: null, ownerEpoch }));
      appendRelocationInView(view, relocationEvent({ ...baseEvent(request.planId), kind: 'state', state: cleanup ? 'RUNNING' : 'QUEUED', issues: [], cleanup: cleanup ? { ...stored.plan.cleanup, state: 'running' } : stored.plan.cleanup, recoveryChoices: [] }));
    }); entry.consumed = true;
    track(request.planId, async controller => {
      if (!cleanup) return execute(request.planId, request.commandId, actor, controller.signal);
      try {
        await options.beforeMedia?.(); assertRelocationMainActor(actor); options.assertCurrent();
        await cleanupRelocationSources({ stored, sourceResourceIds: (request as dto.LocalRelocationPlanCleanup).sourceResourceIds, signal: controller.signal,
          assertCurrent: options.assertCurrent, phase: fact => phase(request.planId, fact),
          verifyProtection: async (claims, sources, namespace) => { const evidence = await protection.inspectHeld(sources, claims, undefined, namespace); clearProtection(evidence); },
          verifyCatalog: () => { for (const operation of stored.operations) { const events = stored.recoveryOrigin?.action === 'reconcile' ? recoveryFamily(stored.plan.planId).flatMap(value => value.events) : stored.events;
            const fact = [...events].reverse().find(event => event.kind === 'location-facts' && event.fact.afterAsset.id === operation.operation.assetId
              && event.fact.target.sourceRootId === operation.operation.target.sourceRootId && event.fact.target.relative === operation.operation.target.relative);
            if (!fact || fact.kind !== 'location-facts' || !same(catalog.privateRelocationSnapshot(fact.fact.afterAsset.id).asset, fact.fact.afterAsset)) return relocationFail('REVISION_CONFLICT'); } },
          binding: { datasetId: options.datasetId, originPlanId: request.planId, planHash: stored.plan.planHash, contextFingerprint: stored.plan.contextFingerprint,
            journalSequence: stored.plan.journalSequence, projectionFingerprint: store.read(view => view.projection.fingerprint) },
        });
        store.state(options.datasetId, request.planId, 'COMPLETED', [], true, { ...stored.plan.cleanup, state: 'completed' });
      } catch (error) { const code = codeOf(error);
        store.state(options.datasetId, request.planId, code === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'SOURCE_RETAINED', [issue(code)], true,
          { ...stored.plan.cleanup, state: code === 'RECOVERY_REQUIRED' ? 'unknown' : 'blocked', issue: issue(code) });
        if (error instanceof RelocationPublicationRecoveryRequired) retainUnknown(request.planId, error); }
    }); return value;
  }
  return {
    prepareRecoveryProtection(): Promise<void> {
      if (preparation) return preparation;
      preparation = (async () => {
        (options.assertRecoveryCurrent ?? options.assertCurrent)();
        blockedRecovery = store.read(view => [...view.projection.plans.values()].some(stored => stored.plan.datasetId === options.datasetId
          && (relocationUnresolvedResources(stored).length || ['RECOVERY_REQUIRED', 'RUNNING', 'QUEUED', 'CANCEL_REQUESTED'].includes(stored.plan.state))));
        if (blockedRecovery) {
          const snapshot = store.read(view => ({ fingerprint: view.projection.fingerprint, plans: [...view.projection.plans.values()].filter(stored => stored.plan.datasetId === options.datasetId
            && (relocationUnresolvedResources(stored).length || ['RECOVERY_REQUIRED', 'RUNNING', 'QUEUED', 'CANCEL_REQUESTED'].includes(stored.plan.state))) }));
          const families = new Map<string, RelocationStoredPlan[]>();
          for (const stored of snapshot.plans) {
            const family = recoveryFamily(stored.plan.planId), prior = families.get(family[0]!.plan.planId);
            if (!prior || family.length > prior.length) families.set(family[0]!.plan.planId, family);
            else if (family.length === prior.length && family.at(-1)!.plan.planId !== prior.at(-1)!.plan.planId) return relocationFail('RECOVERY_REQUIRED');
          }
          for (const family of families.values()) {
            const stored = family[0]!;
            for (const resource of stored.resources) {
              if (!same(repository.sources.root(resource.sourceRoot.id), resource.sourceRoot) || !same(repository.sources.root(resource.targetRoot.id), resource.targetRoot)) return relocationFail('ROOT_CHANGED');
              if (await sourceRootAvailability(resource.sourceRoot) !== 'ONLINE' || await sourceRootAvailability(resource.targetRoot) !== 'ONLINE') return relocationFail('ROOT_OFFLINE');
              (options.assertRecoveryCurrent ?? options.assertCurrent)();
            }
            const held = await holdRelocationRecoveryProtection(stored, snapshot.fingerprint, family);
            uncertain.set(family.at(-1)!.plan.planId, held); recoveryGroups.set(stored.plan.planId, adoptRelocationRecoveryGroup(family, held));
          }
        }
        if (directory) {
          await mkdir(directory, { mode: 0o700, recursive: true }); const info = await lstat(directory, { bigint: true });
          if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory || (info.mode & 0o7777n) !== 0o700n
            || typeof process.getuid !== 'function' || info.uid !== BigInt(process.getuid())) return relocationFail('UNQUALIFIED');
          const cap: RootCapability = { id: randomUUID(), path: directory, dev: String(info.dev), ino: String(info.ino), authorized: true, label: '位置域私有材料' };
          const identity = await observeRelocationRootIdentity(cap); qualified = relocationHash({ publisher: 'NONATOMIC_CAPTURE_NO_OVERWRITE_WHOLE_BYTES_V1', identity });
        }
        prepared = true;
      })(); return preparation;
    },
    async preview(raw: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview']): Promise<dto.LocalRelocationPlanReceipt> {
      const request = capture('localRelocationPlan.preview', raw), prior = store.receipt('localRelocationPlan.preview', request); if (prior) return prior;
      let rejection: dto.LocalRelocationPlanIssueCode | undefined;
      try {
        writingPolicy(undefined, request.intent.kind === 'recovery');
        if (request.intent.kind === 'recovery') {
          const intent = request.intent, family = recoveryFamily(intent.originPlanId), current = recoverableChoices(family.at(-1)!);
          if (!current.some(value => value.choiceId === intent.choiceId && value.expectedOriginViewRevision === intent.expectedOriginViewRevision
            && value.recoveryFingerprint === intent.recoveryFingerprint)) return relocationFail('STALE_VIEW');
          idle(undefined, family.map(value => value.plan.planId));
        } else idle(); store.capacity(1);
      } catch (error) { rejection = codeOf(error); }
      if (rejection) { const value = receipt('localRelocationPlan.preview', request, null, rejection); persistReceipt('localRelocationPlan.preview', request, value); return value; }
      const planId = randomUUID(), createdAt = new Date(now()).toISOString(), header: dto.LocalRelocationPlan = { version: 1, domain, datasetId: options.datasetId, planId, jobId: randomUUID(),
        viewRevision: '1', journalSequence: '1', createdAt, expiresAt: new Date(now() + 1_800_000).toISOString(), planHash: zeroHash, contextFingerprint: zeroHash, policyRevision: policy().revision,
        intent: request.intent, state: 'PREVIEWING', sourceDisposition: request.intent.kind === 'recovery' ? 'RETAIN' : request.intent.sourceDisposition,
        closure: { complete: false, operationCount: 0, resourceCount: 0, referenceEdgeCount: 0, rootCount: 0, fingerprint: zeroHash, totalSourceBytes: '0', spaceVerified: false, protection: 'unknown' },
        items: [], resources: [], referenceEdges: [], issues: [], cleanup: unavailableCleanup(), recoveryChoices: [] };
      const value = receipt('localRelocationPlan.preview', request, header); persistReceipt('localRelocationPlan.preview', request, value, header);
      track(planId, controller => preparePlan(request, planId, controller.signal)); return value;
    },
    async setPolicy(raw: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.setPolicy']): Promise<dto.LocalRelocationPlanReceipt> {
      const request = capture('localRelocationPlan.setPolicy', raw), prior = store.receipt('localRelocationPlan.setPolicy', request); if (prior) return prior;
      const current = policy(); if (current.revision !== request.expectedPolicyRevision) { const rejected = receipt('localRelocationPlan.setPolicy', request, null, 'REVISION_CONFLICT'); persistReceipt('localRelocationPlan.setPolicy', request, rejected); return rejected; }
      if (request.enabled && !qualified) { const rejected = receipt('localRelocationPlan.setPolicy', request, null, 'UNQUALIFIED'); persistReceipt('localRelocationPlan.setPolicy', request, rejected); return rejected; }
      const value = receipt('localRelocationPlan.setPolicy', request, null, undefined, { enabled: request.enabled, revision: String(BigInt(current.revision) + 1n), draining: !request.enabled && runs.size > 0 });
      persistReceipt('localRelocationPlan.setPolicy', request, value);
      if (!request.enabled) for (const running of runs.values()) if (!running.mutated) running.controller.abort(); return value;
    },
    async cancel(raw: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.cancel']): Promise<dto.LocalRelocationPlanReceipt> {
      const request = capture('localRelocationPlan.cancel', raw), prior = store.receipt('localRelocationPlan.cancel', request); if (prior) return prior;
      const stored = store.plan(options.datasetId, request.planId); if (stored.plan.viewRevision !== request.expectedViewRevision) return relocationFail('STALE_VIEW');
      if (terminal.has(stored.plan.state) || uncertain.has(request.planId)) return relocationFail('BUSY');
      const value = receipt('localRelocationPlan.cancel', request, stored.plan); persistReceipt('localRelocationPlan.cancel', request, value);
      const running = runs.get(request.planId); if (running && !running.mutated) { running.controller.abort(); store.state(options.datasetId, request.planId, 'CANCEL_REQUESTED'); }
      else if (running) store.state(options.datasetId, request.planId, 'CANCEL_REQUESTED');
      else { const runtime = runtimes.get(request.planId); if (runtime?.storage) releaseRelocationStorage(runtime.storage);
        if (runtime?.recovery) await invalidateRelocationRecoveryPreparation(runtime.recovery.access);
        runtimes.delete(request.planId); store.state(options.datasetId, request.planId, 'CANCELLED', [], true); }
      return value;
    },
    async get(raw: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get']): Promise<dto.LocalRelocationPlanGetResult> {
      const request = capture('localRelocationPlan.get', raw), selector = request.selector;
      if (selector.kind === 'context') return { datasetId: options.datasetId, kind: 'context', policy: policy(), qualification: { state: qualified ? 'qualified' : 'unqualified',
        proofFingerprint: qualified, issue: qualified ? null : issue('UNQUALIFIED') } };
      if (selector.kind === 'command') { const found = store.commandReceipt(options.datasetId, selector.commandId, selector.expectedCommand, selector.requestFingerprint);
        const issued = store.read(view => view.projection.capabilities.get(selector.commandId));
        if (issued && (issued.issued.requestFingerprint !== selector.requestFingerprint || issued.issued.command !== selector.expectedCommand)) return relocationFail('INVALID_REQUEST');
        return { datasetId: options.datasetId, kind: 'command', commandId: selector.commandId, expectedCommand: selector.expectedCommand, requestFingerprint: selector.requestFingerprint,
          receipt: found, issue: found ? null : issue(issued ? 'COMMAND_UNKNOWN' : 'NOT_FOUND') }; }
      try { const stored = store.plan(options.datasetId, selector.planId); stored.plan.recoveryChoices = recoverableChoices(stored);
        return { datasetId: options.datasetId, kind: 'plan', planId: selector.planId, plan: stored.plan, issue: null }; }
      catch (error) { if (error instanceof LocalRelocationError && error.code === 'NOT_FOUND') return { datasetId: options.datasetId, kind: 'plan', planId: selector.planId, plan: null, issue: issue('NOT_FOUND') }; throw error; }
    },
    async history(raw: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.history']): Promise<dto.LocalRelocationPlanHistory> { return store.history(capture('localRelocationPlan.history', raw)); },
    async dispatchMain(raw: dto.LocalRelocationMainRequest, actor: RelocationMainActor): Promise<unknown> {
      check(); assertRelocationMainActor(actor); const request = dto.localRelocationMainRequestSnapshot(raw); if (request.payload.datasetId !== options.datasetId) return relocationFail('INVALID_REQUEST');
      if (request.command === 'localRelocationMain.captureTarget') {
        const input = request.payload, absolute = input.absolutePath, info = await lstat(absolute, { bigint: true });
        if (info.isSymbolicLink() || await realpath(absolute) !== absolute || input.kind === 'directory' && !info.isDirectory() || input.kind === 'file' && !info.isFile()) return relocationFail('SYMLINK');
        for (const [id, old] of choices) if (Date.parse(old.view.expiresAt) <= now()) choices.delete(id);
        if (choices.size >= dto.LOCAL_RELOCATION_PLAN_BUDGET.sourceAndTargetRoots) return relocationFail('OVER_BUDGET');
        const directoryPath = input.kind === 'directory' ? absolute : path.dirname(absolute), sourceRoots = repository.sources.roots();
        let root = sourceRoots.filter(cap => cap.authorized && inside(cap.path, directoryPath)).sort((a, b) => b.path.length - a.path.length)[0];
        if (!root) { const stat = await lstat(directoryPath, { bigint: true }); root = repository.sources.authorize(input.commandId,
          { path: directoryPath, dev: String(stat.dev), ino: String(stat.ino), authorized: true, label: '已选择的位置目录' }); }
        if (await sourceRootAvailability(root) !== 'ONLINE') return relocationFail('ROOT_OFFLINE');
        const identity = await observeRelocationRootIdentity(root), view: dto.LocalRelocationTargetChoice = { choiceId: randomUUID(), kind: input.kind, label: path.basename(absolute), expiresAt: new Date(now() + 600_000).toISOString() };
        const value: Choice = { view, root, relativeDirectory: path.relative(root.path, directoryPath).split(path.sep).join('/') || '.', fileRelative: input.kind === 'file' ? path.relative(root.path, absolute).split(path.sep).join('/') : null, identity, actor };
        if (!dto.isLocalRelocationMainCommandResult(request.command, view)) return relocationFail('INVALID_REQUEST'); choices.set(view.choiceId, value); return structuredClone(view);
      }
      if (request.command === 'localRelocationMain.challenge') return challenge(request.payload.confirm, actor, false);
      if (request.command === 'localRelocationMain.challengeCleanup') return challenge(request.payload.cleanup, actor, true);
      if (request.command === 'localRelocationMain.executeGranted') return granted(request.payload.confirm, request.payload.grant, actor, false);
      return granted(request.payload.cleanup, request.payload.grant, actor, true);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise; closing = true;
      for (const running of runs.values()) if (!running.mutated) running.controller.abort();
      closePromise = (async () => { await Promise.allSettled([...pending]); await protection.close(); store.close(); choices.clear(); grants.clear();
        if (uncertain.size || fatal) throw fatal ?? new Error('位置文件发布未完成真实quiet，保全claims和材料仍保留。'); })(); return closePromise;
    },
  };
}
export type LocalRelocationService = ReturnType<typeof createLocalRelocationService>;
