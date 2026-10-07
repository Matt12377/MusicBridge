import { randomUUID } from 'node:crypto';
import type { LocalOrganizerPlan } from '../../src/local-organizer.js';
export function organizerPlanFixture(): LocalOrganizerPlan {
  const root = randomUUID(), operation = { operation_id: randomUUID(), kind: 'MB_OVERRIDE' as const, root_id: root, target_asset_id: randomUUID(), expected_asset_revision: '1', source_relative_path: '合成目录/曲目.wav', target_relative_path: null,
    field_patch: { title: '人工曲目' }, backup_required: false };
  const createdAt = '2026-10-07T00:00:00.000Z', expiresAt = '2026-10-07T00:15:00.000Z', trackId = randomUUID();
  return { planId: randomUUID(), revision: '1', datasetId: randomUUID(), scope: 'MB_ONLY', planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), createdAt, expiresAt,
    body: { created_at: createdAt, scope: 'MB_ONLY', operations: [operation], root_mapping_revisions: { [root]: '1' }, conflicts: [], resource_guards: { require_exclusive_asset_lock: false, defer_if_read_lease: false, protect_frozen_sources: true, recheck_at_execution: true } },
    items: [{ operation, trackId, selectionRevision: '1', rootRevision: '1', locationRevision: '1', overrideRevision: null, raw: { title: '原始曲目' }, before: { fields: {}, annotations: {} }, after: { fields: { title: '人工曲目' }, annotations: {} },
      permission: { sourceRootId: randomUUID(), authorized: true, dev: '1', ino: '2' }, sourceObservation: { status: 'unknown', fileSignature: null, permissionMode: null, rootPermissionMode: null, directoryIds: [] },
      protection: { resources: [], complete: true, activeLease: 'not-applicable', frozenReferences: 'not-applicable', writable: 'not-applicable', backupBytes: null } }],
    editionBindings: [], state: 'DRAFT', issue: null, results: [{ operationId: operation.operation_id, trackId, state: 'planned', overrideRevision: null, issue: null }], undoOf: null };
}
