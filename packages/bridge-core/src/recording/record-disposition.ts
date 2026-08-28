import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { recordFail } from './record-integrity.js';
import type { RecordingRecordStore } from './record-store.js';

const effects = { 'mark-content-unknown': 'content-unknown', 'confirm-current-recording': 'content-confirmed', 'prepare-rerecord': 'rerecord-reserved', 'cancel-rerecord': 'rerecord-cancelled', 'confirm-erased': 'erased-confirmed' } as const;
const copySql = 'SELECT c.*,l.sku_id,s.model_id,s.minutes,m.descriptor,m.policy,m.minimum_sealed FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id JOIN collection_models m ON m.id=s.model_id WHERE c.physical_id=?';
function mediaPlan(db: DatabaseSync, id: string): dto.MediaPlan {
  const row = db.prepare('SELECT * FROM media_plans WHERE id=?').get(id);
  if (!row) return recordFail('CONFLICT');
  const data = JSON.parse(String(row.data)) as dto.MediaPlan;
  const draft = db.prepare('SELECT revision FROM master_drafts WHERE id=?').get(row.draft_id!);
  const reservation = db.prepare('SELECT data FROM media_reservations WHERE plan_id=?').get(id);
  const result = { ...data, revision: Number(row.revision), requiresReview: !draft || draft.revision !== data.draftRevision, ...(reservation ? { reservation: JSON.parse(String(reservation.data)) as dto.MediaReservation } : {}) };
  if (!dto.isMediaPlan(result) || result.id !== id || result.draftId !== row.draft_id) return recordFail('IO_ERROR');
  return result;
}

function capture(store: RecordingRecordStore, db: DatabaseSync, request: dto.PreviewPhysicalRecordingDispositionRequest, assertExecutionIdle: () => void) {
  assertExecutionIdle();
  if (db.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress' LIMIT 1").get()) return recordFail('NOT_READY');
  const before = store.state(db, request.physicalId), copy = db.prepare(copySql).get(request.physicalId);
  const expected = before.latestAttempt ? { id: before.latestAttempt.id, revision: before.latestAttempt.revision } : null;
  if (!copy || request.expectedPhysicalRevision !== before.physicalRevision || request.expectedContentRevision !== before.revision || mediaFingerprint(request.expectedAttempt) !== mediaFingerprint(expected)) return recordFail('CONFLICT');
  // 终态、ACK或某一瞬间没有回调都不是这三个独立证据的替代。
  const attempts = db.prepare('SELECT data FROM recording_attempts WHERE physical_id=? ORDER BY rowid').all(request.physicalId).map(row => {
    const attempt: unknown = JSON.parse(String(row.data)); if (!dto.isRecordingAttempt(attempt)) return recordFail('IO_ERROR'); return attempt;
  });
  if (attempts.some(attempt => attempt.sides.some(side => side.runId && (!side.engineStoppedSubmitting || !side.cleanupQuiescent || !side.physicalStopConfirmedAt)))) return recordFail('NOT_READY');
  if (copy.usage === 'blank' || copy.packaging === 'sealed' || copy.usage === 'reserved' && !attempts.length && !before.activeRerecordPermit) return recordFail('CONFLICT');
  const intent = request.intent, permit = before.activeRerecordPermit;
  if (permit && intent.action !== 'cancel-rerecord' || !permit && intent.action === 'cancel-rerecord') return recordFail('CONFLICT');
  const reservations = db.prepare('SELECT * FROM media_reservations WHERE physical_id=? ORDER BY plan_id').all(request.physicalId);
  const heldPlans = reservations.map(row => mediaPlan(db, String(row.plan_id)));
  let target: dto.MediaPlan | undefined;
  if (intent.action === 'confirm-current-recording') {
    const record = store.record(db, intent.recordingId);
    if (!record || record.completion.physicalId !== request.physicalId) return recordFail('CONFLICT');
  } else if (intent.action === 'prepare-rerecord') {
    target = mediaPlan(db, intent.mediaPlanId);
    if (target.revision !== intent.expectedMediaPlanRevision || target.reservation || target.requiresReview || target.sourceBasis === 'unavailable' || target.layout.constraints.length
      || attempts.some(attempt => {
        const row = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(attempt.planVersionId);
        return !row || (JSON.parse(String(row.data)) as dto.RecordingPlanVersion).layout.planId === target!.id;
      })) return recordFail('CONFLICT');
    const descriptor: unknown = JSON.parse(String(copy.descriptor));
    if (!dto.isImportedCollectionDescriptor(descriptor)) return recordFail('IO_ERROR');
    const minutes = Number(copy.minutes), capacity = minutes * 60_000 / (target.spec.format === 'cassette' ? 2 : 1);
    if (copy.available !== 1 || copy.packaging !== 'opened' || copy.policy === 'collector' || minutes < 1 || descriptor.format !== target.spec.format
      || !target.spec.compatibility.confirmed || (descriptor.format === 'dat' ? descriptor.tapeType !== 'dat' || !target.spec.compatibility.dat : descriptor.tapeType === 'unknown' || descriptor.tapeType === 'dat' || !target.spec.compatibility.cassetteTypes.includes(descriptor.tapeType))
      || target.layout.sides.some(side => side.durationMs === undefined || side.durationMs > capacity)) return recordFail('CONFLICT');
  } else if (intent.action === 'cancel-rerecord') {
    if (!permit || permit.id !== intent.permitId) return recordFail('CONFLICT');
    target = mediaPlan(db, permit.mediaPlanId);
    if (target.revision !== permit.mediaPlanRevision || target.reservation?.physicalId !== request.physicalId || copy.usage !== 'reserved' || !['recorded', 'unknown', 'erased'].includes(String(copy.reserved_from))) return recordFail('CONFLICT');
  }
  return { before, copy, attempts, reservations, heldPlans, ...(target ? { target } : {}) };
}
function fingerprint(request: dto.PreviewPhysicalRecordingDispositionRequest, facts: ReturnType<typeof capture>) { return mediaFingerprint({ request, facts }); }
function detach(db: DatabaseSync, physicalId: string): void {
  for (const row of db.prepare('SELECT plan_id FROM media_reservations WHERE physical_id=?').all(physicalId)) db.prepare('UPDATE media_plans SET revision=revision+1 WHERE id=?').run(row.plan_id!);
  db.prepare('DELETE FROM media_reservations WHERE physical_id=?').run(physicalId);
}

/** 同步控制线程处置；所有持久变化都留在同一store事务，不调用输出provider。 */
export function createRecordingDispositionService(store: RecordingRecordStore, assertExecutionIdle: () => void) {
  return {
    preview(request: dto.PreviewPhysicalRecordingDispositionRequest): dto.PhysicalRecordingDispositionProposal {
      if (!dto.isPreviewPhysicalRecordingDispositionRequest(request)) return recordFail('INVALID_REQUEST');
      return store.read(db => {
        const facts = capture(store, db, request, assertExecutionIdle);
        const result = { request: structuredClone(request), checkedAt: new Date().toISOString(), proposalFingerprint: fingerprint(request, facts), before: facts.before, effect: effects[request.intent.action], outputWillStart: false as const };
        if (!dto.isPhysicalRecordingDispositionProposal(result)) return recordFail('IO_ERROR'); return result;
      });
    },
    apply(request: dto.ApplyPhysicalRecordingDispositionRequest): dto.ApplyPhysicalRecordingDispositionResult {
      if (!dto.isApplyPhysicalRecordingDispositionRequest(request)) return recordFail('INVALID_REQUEST');
      return store.transaction('recording-disposition', db => {
        const prior = store.cached(db, request); if (prior) return prior;
        const { commandId: _commandId, proposalFingerprint, userConfirmed: _confirmed, ...preview } = request;
        const facts = capture(store, db, preview, assertExecutionIdle);
        if (fingerprint(preview, facts) !== proposalFingerprint) return recordFail('CONFLICT');
        const { before, copy } = facts, intent = request.intent;
        const at = new Date(Math.max(Date.now(), ...facts.attempts.map(attempt => Date.parse(attempt.updatedAt)))).toISOString(), id = randomUUID();
        let knowledge = before.knowledge, permit: dto.RerecordPermit | undefined, resultPlan: dto.MediaPlan | undefined;
        if (intent.action === 'mark-content-unknown') knowledge = { state: 'unknown', reason: 'manual-unknown', since: at };
        if (intent.action === 'confirm-current-recording') knowledge = { state: 'confirmed-recording', recordingId: intent.recordingId, confirmedAt: at, evidence: { kind: 'manual-disposition', dispositionId: id } };
        if (intent.action === 'confirm-erased') knowledge = { state: 'erased', confirmedAt: at, dispositionId: id };
        store.withPhysicalMutation(db, request.physicalId, intent.action, () => {
          if (copy.usage === 'erased' && (intent.action === 'mark-content-unknown' || intent.action === 'confirm-current-recording')) {
            // 用户撤销“已擦除”认知时，同步撤销其空白候选资格；不改变其他实体数量。
            db.prepare('UPDATE physical_copies SET usage=?,revision=revision+1 WHERE physical_id=?').run(intent.action === 'mark-content-unknown' ? 'unknown' : 'recorded', request.physicalId);
          }
          if (intent.action === 'prepare-rerecord') {
            const target = facts.target!;
            // 迁移保留的reserved_from可能仍为blank，不能沿用它宣称旧录音已擦除。
            const from = before.knowledge.state === 'confirmed-recording' ? 'recorded' : before.knowledge.state === 'erased' ? 'erased' : 'unknown';
            detach(db, request.physicalId);
            db.prepare("UPDATE physical_copies SET usage='reserved',reserved_from=?,revision=revision+1 WHERE physical_id=?").run(from, request.physicalId);
            const reservation: dto.MediaReservation = { physicalId: request.physicalId, modelId: String(copy.model_id), skuId: String(copy.sku_id), packaging: 'opened' };
            db.prepare('INSERT INTO media_reservations VALUES(?,?,?)').run(target.id, request.physicalId, JSON.stringify(reservation));
            db.prepare('UPDATE media_plans SET revision=revision+1 WHERE id=?').run(target.id);
            resultPlan = mediaPlan(db, target.id);
            permit = { id: randomUUID(), physicalId: request.physicalId, dispositionId: id, createdAt: at, mediaPlanId: target.id, mediaPlanRevision: resultPlan.revision,
              contentRevision: before.revision + 1, physicalRevision: before.physicalRevision + 1, precedingAttempt: preview.expectedAttempt, state: 'available' };
          } else if (intent.action === 'cancel-rerecord') {
            const active = before.activeRerecordPermit!;
            detach(db, request.physicalId);
            db.prepare('UPDATE physical_copies SET usage=reserved_from,reserved_from=NULL,revision=revision+1 WHERE physical_id=?').run(request.physicalId);
            resultPlan = mediaPlan(db, active.mediaPlanId);
            permit = { ...active, state: 'revoked', dispositionIdOfRevocation: id, revokedAt: at };
          } else if (intent.action === 'confirm-erased') {
            detach(db, request.physicalId);
            db.prepare("UPDATE physical_copies SET usage='erased',reserved_from=NULL,revision=revision+1 WHERE physical_id=?").run(request.physicalId);
          }
        });
        const physicalRevision = Number(db.prepare('SELECT revision FROM physical_copies WHERE physical_id=?').get(request.physicalId)!.revision);
        const state: dto.PhysicalRecordingState = { ...before, revision: before.revision + 1, physicalRevision, knowledge, activeRerecordPermit: permit?.state === 'available' ? permit : null };
        const disposition: dto.PhysicalRecordingDisposition = { id, physicalId: request.physicalId, createdAt: at, intent, beforeContentRevision: before.revision, afterContentRevision: state.revision,
          beforePhysicalRevision: before.physicalRevision, afterPhysicalRevision: physicalRevision, observedAttempt: preview.expectedAttempt,
          ...(intent.action === 'prepare-rerecord' || intent.action === 'cancel-rerecord' ? { permitId: permit!.id } : {}) };
        const result: dto.ApplyPhysicalRecordingDispositionResult = { disposition, state, ...(resultPlan ? { mediaPlan: resultPlan } : {}) };
        if (!dto.isApplyPhysicalRecordingDispositionResult(result)) return recordFail('IO_ERROR');
        return store.commitDisposition(db, { request, result, ...(permit ? { permit } : {}), ...(before.activeRerecordPermit ? { priorPermit: before.activeRerecordPermit } : {}) });
      });
    },
  };
}
