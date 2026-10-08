import type { LocalRelocationPlan, LocalRelocationPlanConfirm, LocalRelocationPlanCleanup, LocalRelocationPlanReceipt } from '../../src/local-relocation-plan.js';
import type { LocalRelocationFrozenBody, LocalRelocationFrozenContext, LocalRelocationMainChallenge, LocalRelocationMainGrant } from '../../src/local-relocation-private.js';

export const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const hash = (n = 1): string => n.toString(16).padStart(64, '0');
export const date = '2026-10-08T10:00:00.000Z';
export const expiresAt = '2026-10-08T10:30:00.000Z';
export const selection = () => ({ assetId: id(10), expectedFileRevision: '3', expectedLocationRevision: '5', expectedRootRevision: '7' });
export const confirm = (): LocalRelocationPlanConfirm => ({ datasetId: id(1), commandId: id(2), planId: id(3), expectedViewRevision: '1', domain: 'LOCAL_RELOCATION_V1', planHash: hash(1), contextFingerprint: hash(2) });
export const cleanup = (): LocalRelocationPlanCleanup => ({ ...confirm(), commandId: id(4), verifiedTargetFingerprint: hash(3), sourceResourceIds: [id(20)] });
export const grant = (action: 'execute' | 'cleanup' = 'execute'): LocalRelocationMainGrant => ({ domain: 'LOCAL_RELOCATION_V1', action, challengeId: id(40), ownerEpoch: id(41), nonce: hash(4), authorityId: id(42), signature: hash(5) });
export const challenge = (action: 'execute' | 'cleanup' = 'execute'): LocalRelocationMainChallenge => ({
  ...confirm(), action, policyRevision: '2', requestFingerprint: hash(6), verifiedTargetFingerprint: action === 'cleanup' ? hash(3) : null,
  sourceResourceIds: action === 'cleanup' ? [id(20)] : [], expiresAt, grant: grant(action),
});
export const receipt = (command: LocalRelocationPlanReceipt['command'] = 'localRelocationPlan.confirm'): LocalRelocationPlanReceipt => ({
  datasetId: id(1), commandId: id(2), command, requestFingerprint: hash(6), planId: command === 'localRelocationPlan.setPolicy' ? null : id(3),
  jobId: command === 'localRelocationPlan.setPolicy' ? null : id(4), outcome: 'accepted',
  policy: command === 'localRelocationPlan.setPolicy' ? { enabled: false, revision: '2', draining: false } : null, issue: null,
});
export function frozenBody(): LocalRelocationFrozenBody {
  const source = { libraryRootId: id(30), sourceRootId: id(31), relative: '原曲.flac', expectedRootRevision: '7' };
  const target = { ...source, relative: '新曲.flac' };
  return {
    version: 1, domain: 'LOCAL_RELOCATION_V1', createdAt: date,
    intent: { kind: 'rename', target: selection(), newName: '新曲.flac', sourceDisposition: 'RETAIN' },
    operations: [{ operationId: id(11), kind: 'rename', assetId: id(10), trackIds: [id(12)], expectedFileRevision: '3', expectedLocationRevision: '5', source, target, resourceIds: [id(20)] }],
    rootMappings: [{ mappingId: id(32), source: { ...source, relative: '' }, target: { ...target, relative: '' }, sourceCapabilityFingerprint: hash(7), targetCapabilityFingerprint: hash(7), sourcePhysicalRootFingerprint: hash(8), targetPhysicalRootFingerprint: hash(8), sourceAncestorFingerprint: hash(9), targetAncestorFingerprint: hash(9) }],
    resourceClosure: { complete: true, fingerprint: hash(10), resources: [{
      resourceId: id(20), role: 'AUDIO', operationIds: [id(11)], source, target, action: 'move', before: { sha256: hash(11), bytes: '1024' }, after: { sha256: hash(11), bytes: '1024' },
      sourceObservationFingerprint: hash(12), targetObservationFingerprint: hash(13), attributesFingerprint: hash(14), sharedMemberIds: [], transitionNames: ['原曲.flac', '新曲.flac'],
    }], referenceEdges: [] },
    sourceRetention: { disposition: 'RETAIN', cleanupRequiresNewGrant: true, resourceIds: [] },
    guards: { noOverwrite: true, preserveAudioWholeBytes: true, unknownReferences: 'BLOCK', physicalRootIdentity: 'REQUIRED', leaseProtection: 'REQUIRED', reservationFingerprint: hash(15) },
  };
}
export const frozenContext = (): LocalRelocationFrozenContext => ({
  version: 1, domain: 'LOCAL_RELOCATION_V1', datasetId: id(1), planId: id(3), viewRevision: '1', policyRevision: '2', ownerEpoch: id(41), targetChoiceIds: [],
  rootObservationFingerprint: hash(16), resourceObservationFingerprint: hash(17), protectionFingerprint: hash(18), reservationFingerprint: hash(15), commandFingerprint: hash(6),
});
export function plan(): LocalRelocationPlan {
  return {
    version: 1, domain: 'LOCAL_RELOCATION_V1', datasetId: id(1), planId: id(3), jobId: id(4), viewRevision: '1', journalSequence: '1', createdAt: date, expiresAt,
    planHash: hash(1), contextFingerprint: hash(2), policyRevision: '2', intent: { kind: 'rename', target: selection(), newName: '新曲.flac', sourceDisposition: 'RETAIN' }, state: 'READY', sourceDisposition: 'RETAIN',
    closure: { complete: true, operationCount: 1, resourceCount: 1, referenceEdgeCount: 0, rootCount: 1, fingerprint: hash(10), totalSourceBytes: '1024', spaceVerified: true, protection: 'verified' },
    items: [{ operationId: id(11), assetId: id(10), trackIds: [id(12)], sourceLabel: '原曲.flac', targetLabel: '新曲.flac', expectedFileRevision: '3', expectedLocationRevision: '5', expectedRootRevision: '7', state: 'pending', phase: 'PLANNED', resourceIds: [id(20)], issue: null }],
    resources: [{ resourceId: id(20), role: 'AUDIO', label: '原曲.flac', operationIds: [id(11)], bytes: '1024', state: 'pending', phase: 'PLANNED', verification: 'unverified', sourceHandling: 'move-pending', contentEffect: 'whole-bytes-preserved', issue: null }],
    referenceEdges: [], issues: [], cleanup: { state: 'unavailable', verifiedTargetFingerprint: null, sourceResourceIds: [], issue: null }, recoveryChoices: [],
  };
}
