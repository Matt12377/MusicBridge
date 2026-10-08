import type { AttachLocalSourceWritesOriginal, ConfirmLocalSourceWrites, LocalSourceWritesContext, LocalSourceWritesPlan, LocalSourceWritesRange, LocalSourceWritesReceipt, PreviewLocalSourceWrites, SourceWritesMainRequest } from '../../src/index.js';
export const id = '11111111-1111-4111-8111-111111111111';
export const other = '22222222-2222-4222-8222-222222222222';
export const hash = 'a'.repeat(64);
export const preview = (): PreviewLocalSourceWrites => ({ datasetId: id, commandId: id, intent: { kind: 'tags', target: { mode: 'single', trackId: id }, fields: { title: { action: 'set', value: '合成标题' } } } });
export const confirm = (): ConfirmLocalSourceWrites => ({ datasetId: id, commandId: other, planId: id, expectedViewRevision: '1', scope: 'SOURCE_FILES', range: 'TAGS', planHash: hash, contextFingerprint: hash });
export const receipt = (): LocalSourceWritesReceipt => ({ datasetId: id, commandId: other, command: 'localSourceWrites.confirm', requestFingerprint: hash, planId: id, jobId: other, outcome: 'accepted', policy: null, issue: null });
export const context = (): LocalSourceWritesContext => ({ datasetId: id, policy: { enabled: false, revision: '1', draining: false }, capabilities: { publisherProfile: 'NONATOMIC_QUARANTINE_LINK_V1', formats: [{ profile: 'NATIVE_FLAC_FIXED_TAG_REGION_V1', qualified: false, tags: false, embeddedCover: false, fields: [], issue: 'FORMAT_NOT_QUALIFIED' }], directoryCover: { qualified: false, issue: 'FORMAT_NOT_QUALIFIED' } }, materials: [] });
export const plan = (): LocalSourceWritesPlan => ({
  version: 1, datasetId: id, planId: id, jobId: other, viewRevision: '1', journalSequence: '1', scope: 'SOURCE_FILES', range: 'TAGS', state: 'READY',
  createdAt: '2026-10-08T00:00:00.000Z', readyAt: '2026-10-08T00:00:01.000Z', expiresAt: '2026-10-08T00:10:01.000Z', policyRevision: '1', planHash: hash, contextFingerprint: hash, journalFingerprint: hash, summary: '一首合成曲目的标题写回',
  items: [{ operationId: id, resourceRef: id, trackId: id, assetId: id, label: '合成音频一', profile: 'NATIVE_FLAC_FIXED_TAG_REGION_V1', expectedFileRevision: '1', currentFileRevision: '1', expectedRootRevision: '1', expectedLocationRevision: '1', expectedSelectionRevision: '1', changes: [{ field: 'title', action: 'set', before: ['旧标题'], after: ['合成标题'] }], artwork: null, state: 'planned', phase: 'PLANNED', backup: { state: 'not-created', bytes: null }, verification: { audio: 'pending', unselectedMetadata: 'pending', content: 'pending', reread: 'pending' }, issue: null }],
  issues: [], resourceSummary: { resources: 4, sharedTargets: 1, backupBytes: '256', spaceVerified: true, protection: 'verified' }, undoOf: null, recoveryOf: null, recoveryChoices: [],
});
export const original = (): AttachLocalSourceWritesOriginal => ({ datasetId: id, commandId: id, target: { trackId: id, editionId: id, expectedEditionRevision: '1', expectedTrackRevision: '1', expectedSourceRevision: hash }, candidateId: id, original: { mime: 'image/png', bytes: 4, sha256: hash, width: 1, height: 1 }, bytes: new Uint8Array([1, 2, 3, 4]) });
export const originalPacket = (): SourceWritesMainRequest => ({ version: 1, type: 'source-writes-request', requestId: id, sequence: 1, command: 'localSourceWrites.attachOriginal', payload: original() });
export const originOperationId = '33333333-3333-4333-8333-333333333333';
export function restorationPlan(range: LocalSourceWritesRange = 'TAGS', absent = false): LocalSourceWritesPlan {
  if (absent && range !== 'DIRECTORY_COVER') throw new Error('不存在的原封面夹具仅适用于目录封面。');
  const value = plan(), item = value.items[0]!;
  value.range = range; value.undoOf = other; value.summary = '恢复原来已核实的状态';
  item.expectedFileRevision = item.currentFileRevision = '2';
  item.restoration = { originPlanId: other, originOperationId, kind: range === 'DIRECTORY_COVER' ? absent ? 'remove-new-directory-cover' : 'restore-directory-cover' : 'restore-audio-file', material: absent ? 'verified-absence' : 'verified-backup', expectedOutputSha256: absent ? null : hash };
  item.changes = range === 'TAGS' ? [{ field: 'artist', action: 'set', before: ['单值新艺人'], after: ['原艺人乙 / 别名', '原艺人甲 e\u0301'] }] : [];
  item.artwork = null;
  if (range === 'DIRECTORY_COVER') { item.profile = null; item.verification.audio = item.verification.unselectedMetadata = 'not-applicable'; }
  return value;
}
