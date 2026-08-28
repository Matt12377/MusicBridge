import { captureMasterArtwork, registerRecordingPrint } from './print-store.js';
import { verifyRecordingAttemptDatabase } from './attempt-integrity.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { captureRecordingVisuals, readRecordingVisual } from './record-visuals.js';
import { RecordingRecordError, recordFail, recordSchema, recordingAttempt20Protection, readContentHead, readPhysicalRecordingState, readRecordingRecord, withPhysicalRecordingMutation, availableRecordingPermit, checkRecordingRecordBudgets, verifyRecordingRecordDatabase, recordingPermitMatchesPlan, type RecordingContentHead, type RecordingContentEvent } from './record-integrity.js';

export interface RecordingRecordBudgets { metadataBudgetBytes?:number; visualBudgetBytes?:number }
interface Access extends RecordingRecordBudgets { read<T>(fn:(db:DatabaseSync)=>T):T;beforeCommit?:(action:string)=>void }
export interface RecordingDispositionCommit { request:dto.ApplyPhysicalRecordingDispositionRequest;result:dto.ApplyPhysicalRecordingDispositionResult;permit?:dto.RerecordPermit;priorPermit?:dto.RerecordPermit }
function assertBudgets(budgets:RecordingRecordBudgets):void {
  for(const [value,max] of [[budgets.metadataBudgetBytes,dto.MAX_RECORDING_RECORD_METADATA_BYTES],[budgets.visualBudgetBytes,dto.MAX_RECORDING_RECORD_VISUAL_OBJECT_BYTES]]) if(value!==undefined && (!Number.isSafeInteger(value)||value<1||value>max!)) return recordFail('INVALID_REQUEST');
}
function appendContent(db:DatabaseSync,before:RecordingContentHead,knowledge:dto.PhysicalRecordingKnowledge,source:RecordingContentEvent['source']):void {
  const copy=db.prepare('SELECT usage,revision FROM physical_copies WHERE physical_id=?').get(before.physicalId); if(!copy) return recordFail();
  const after={physicalId:before.physicalId,revision:before.revision+1,knowledge};
  const previousHash=before.revision?String(db.prepare('SELECT event_hash FROM recording_record_current WHERE physical_id=?').get(before.physicalId)?.event_hash??''):'';
  const data:RecordingContentEvent={before,after,source,usage:String(copy.usage),physicalRevision:Number(copy.revision)},encoded=JSON.stringify(data),hash=mediaFingerprint({physicalId:after.physicalId,revision:after.revision,previousHash,data});
  db.prepare('INSERT INTO recording_record_events VALUES(?,?,?,?,?,?)').run(after.physicalId,after.revision,source.kind,encoded,previousHash,hash);
  db.prepare('INSERT INTO recording_record_current VALUES(?,?,?,?) ON CONFLICT(physical_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,event_hash=excluded.event_hash').run(after.physicalId,after.revision,JSON.stringify(after),hash);
}
function writePermit(db:DatabaseSync,permit:dto.RerecordPermit):void {
  if(!dto.isRerecordPermit(permit)) return recordFail();
  db.prepare('INSERT INTO recording_record_permits VALUES(?,?,?,?,?)').run(permit.id,permit.state==='available'?1:2,permit.physicalId,permit.state,JSON.stringify(permit));
}
/** 调用方拥有Attempt事务；首次Completed后才拍快照，任何预算失败令整个完成事务回滚。 */
export function registerCompletedRecording(db:DatabaseSync,completion:dto.RecordingAttempt,budgets:RecordingRecordBudgets={},legacy=false):void {
  assertBudgets(budgets);
  if(completion.status!=='completed') return;
  const existing=db.prepare('SELECT attempt_revision FROM recording_records WHERE attempt_id=?').get(completion.id); if(existing) return;
  const first=db.prepare("SELECT revision,data FROM recording_attempt_events WHERE attempt_id=? AND json_extract(data,'$.after.status')='completed' ORDER BY revision LIMIT 1").get(completion.id);
  if(!first || first.revision!==completion.revision || mediaFingerprint((JSON.parse(String(first.data)) as {after:dto.RecordingAttempt}).after)!==mediaFingerprint(completion)) return recordFail();
  const planRow=db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(completion.planVersionId); if(!planRow) return recordFail();
  const plan=JSON.parse(String(planRow.data)) as dto.RecordingPlanVersion;
  const id=randomUUID(),base={modelId:plan.layout.reservation.modelId,lotId:plan.physicalCopy.lotId,skuId:plan.physicalCopy.skuId,lengthMinutes:plan.physicalCopy.lengthMinutes,origin:plan.physicalCopy.origin};
  const model=db.prepare('SELECT descriptor FROM collection_models WHERE id=?').get(base.modelId); if(!model) return recordFail();
  const printing=!legacy&&Number(db.prepare('PRAGMA user_version').get()?.user_version)>=21;
  const printRequestId=printing&&plan.layout.spec.format==='cassette'?randomUUID():null;
  const visuals=captureRecordingVisuals(db,id,completion.physicalId,legacy);
  const body={...(printing?{schemaVersion:2 as const,printRequestId}:{schemaVersion:1 as const}),id,createdAt:completion.endedAt!,completion:completion as dto.CompletedRecordingAttempt,
    media:legacy?{...base,snapshotSource:'legacy-plan-only' as const}:{...base,snapshotSource:'completion' as const,descriptor:JSON.parse(String(model.descriptor)) as dto.CollectionDescriptor},visuals:printing?{...visuals,artwork:captureMasterArtwork(db,plan.master.id),jCard:{state:'not-captured' as const,reason:plan.layout.spec.format==='cassette'?'not-provided' as const:'not-applicable' as const}}:visuals};
  const candidate={...body,contentHash:mediaFingerprint(body)};
  if(!dto.isRecordingRecord(candidate))return recordFail();const record=candidate;
  const before=readContentHead(db,completion.physicalId);
  db.prepare('INSERT INTO recording_records VALUES(?,?,?,?,?,?)').run(id,completion.id,completion.revision,completion.physicalId,completion.planVersionId,JSON.stringify(record));
  if(printRequestId)registerRecordingPrint(db,record,plan,printRequestId,'completion',record.createdAt);
  if(!legacy) withPhysicalRecordingMutation(db,completion.physicalId,'completed',()=>{
    db.prepare("UPDATE physical_copies SET usage='recorded',reserved_from=NULL,revision=revision+1 WHERE physical_id=? AND usage='reserved'").run(completion.physicalId);
    const reservation=db.prepare('SELECT plan_id FROM media_reservations WHERE physical_id=?').get(completion.physicalId);
    if(reservation) { db.prepare('DELETE FROM media_reservations WHERE physical_id=?').run(completion.physicalId); db.prepare('UPDATE media_plans SET revision=revision+1 WHERE id=?').run(String(reservation.plan_id)); }
  });
  appendContent(db,before,{state:'confirmed-recording',recordingId:id,confirmedAt:completion.endedAt!,evidence:{kind:'completed-attempt',attemptId:completion.id,revision:completion.revision}},{kind:legacy?'legacy-completed':'completed',attemptId:completion.id,revision:completion.revision,recordingId:id,recordingContentHash:record.contentHash});
  checkRecordingRecordBudgets(db,budgets.metadataBudgetBytes,budgets.visualBudgetBytes);
}
/** 准入已经完成；与新Attempt的持久化边界同事务使旧当前内容失效并一次消费许可。 */
export function beginPhysicalRecording(db:DatabaseSync,attempt:dto.RecordingAttempt,plan:dto.RecordingPlanVersion,budgets:RecordingRecordBudgets={}):void {
  const before=readContentHead(db,attempt.physicalId), priorAttempt=db.prepare('SELECT 1 FROM recording_attempts WHERE physical_id=? AND id<>? LIMIT 1').get(attempt.physicalId,attempt.id);
  const permit=availableRecordingPermit(db,attempt.physicalId);
  if(priorAttempt || before.revision>0 || permit) {
    if(!permit || permit.state!=='available' || !recordingPermitMatchesPlan(db,attempt.physicalId,plan.layout.planId,plan.mediaPlanRevision)) return recordFail('CONFLICT');
    const prior=db.prepare('SELECT id,revision FROM recording_attempts WHERE physical_id=? AND id<>? ORDER BY rowid DESC LIMIT 1').get(attempt.physicalId,attempt.id);
    if(mediaFingerprint(permit.precedingAttempt)!==mediaFingerprint(prior?{id:String(prior.id),revision:Number(prior.revision)}:null)) return recordFail('CONFLICT');
    writePermit(db,{...permit,state:'consumed',attemptId:attempt.id,planVersionId:plan.id,planContentHash:plan.contentHash,consumedAt:attempt.createdAt});
  }
  appendContent(db,before,{state:'unknown',reason:'new-attempt',since:attempt.createdAt},{kind:'begin',attemptId:attempt.id,revision:attempt.revision,...(permit?{permitId:permit.id}:{})});
  checkRecordingRecordBudgets(db,budgets.metadataBudgetBytes,budgets.visualBudgetBytes);
}
/** 外层已关闭FK并拥有迁移事务。保留旧表每列事实，只扩大受控重录reserved_from。 */
export function migrateRecordingRecords(db:DatabaseSync):void {
  verifyRecordingAttemptDatabase(db);
  const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND (sql LIKE '%physical_copies%' OR name IN ('recording_attempt_reservation_no_delete','recording_attempt_reservation_no_rebind'))").all();
  for(const trigger of triggers) db.exec(`DROP TRIGGER "${String(trigger.name)}"`);
  const oldSql=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='physical_copies'").get()!.sql);
  db.exec(oldSql.replace('physical_copies','physical_copies_recording20').replace("reserved_from IN ('blank','erased')","reserved_from IN ('blank','erased','recorded','unknown')"));
  db.exec('INSERT INTO physical_copies_recording20 SELECT * FROM physical_copies; DROP TABLE physical_copies; ALTER TABLE physical_copies_recording20 RENAME TO physical_copies; CREATE INDEX physical_copies_lot ON physical_copies(lot_id);');
  for(const trigger of triggers) {
    const replacement=recordingAttempt20Protection.find(sql=>sql.startsWith(`CREATE TRIGGER ${String(trigger.name)} `)); db.exec(replacement??String(trigger.sql));
  }
  for(const sql of recordSchema) db.exec(sql);
  db.exec('PRAGMA user_version=20');
  for(const row of db.prepare("SELECT e.data FROM recording_attempt_events e WHERE json_extract(e.data,'$.after.status')='completed' AND NOT EXISTS(SELECT 1 FROM recording_attempt_events p WHERE p.attempt_id=e.attempt_id AND p.revision<e.revision AND json_extract(p.data,'$.after.status')='completed') ORDER BY e.rowid").all()) registerCompletedRecording(db,(JSON.parse(String(row.data)) as {after:dto.RecordingAttempt}).after,{},true);
  verifyRecordingRecordDatabase(db);
}
export function createRecordingRecordStore(access:Access) {
  assertBudgets(access);
  return {
    read:access.read,
    state:readPhysicalRecordingState,
    record:readRecordingRecord,
    withPhysicalMutation:withPhysicalRecordingMutation,
    visual(request:dto.RecordingVisualRequest):dto.RecordingVisualResult { return access.read(db=>readRecordingVisual(db,request)); },
    cached(db:DatabaseSync,request:dto.ApplyPhysicalRecordingDispositionRequest):dto.ApplyPhysicalRecordingDispositionResult|undefined {
      const prior=db.prepare('SELECT fingerprint,result FROM recording_record_receipts WHERE command_id=?').get(request.commandId); if(!prior) return undefined;
      if(prior.fingerprint!==mediaFingerprint(request)) return recordFail('COMMAND_CONFLICT');
      const value=JSON.parse(String(prior.result)); if(!dto.isApplyPhysicalRecordingDispositionResult(value)) return recordFail(); return value;
    },
    transaction<T>(action:string,fn:(db:DatabaseSync)=>T):T {
      return access.read(db=>{ db.exec('BEGIN IMMEDIATE');try {
        verifyRecordingRecordDatabase(db); const result=fn(db); checkRecordingRecordBudgets(db,access.metadataBudgetBytes,access.visualBudgetBytes); verifyRecordingRecordDatabase(db);access.beforeCommit?.(action);db.exec('COMMIT');return result;
      }catch(error){db.exec('ROLLBACK');if(error instanceof RecordingRecordError)throw error;return recordFail();} });
    },
    commitDisposition(db:DatabaseSync,{request,result,permit,priorPermit}:RecordingDispositionCommit):dto.ApplyPhysicalRecordingDispositionResult {
      if(!dto.isApplyPhysicalRecordingDispositionRequest(request)||!dto.isApplyPhysicalRecordingDispositionResult(result)) return recordFail('INVALID_REQUEST');
      const before=readContentHead(db,request.physicalId);
      if(before.revision!==request.expectedContentRevision || result.disposition.beforeContentRevision!==before.revision || result.state.revision!==before.revision+1) return recordFail('CONFLICT');
      if(priorPermit) { const existing=availableRecordingPermit(db,request.physicalId);if(!existing||mediaFingerprint(existing)!==mediaFingerprint(priorPermit)) return recordFail('CONFLICT'); }
      if(permit)writePermit(db,permit);
      appendContent(db,before,result.state.knowledge,{kind:'disposition',disposition:result.disposition});
      if(mediaFingerprint(readPhysicalRecordingState(db,request.physicalId))!==mediaFingerprint(result.state)) return recordFail('CONFLICT');
      db.prepare('INSERT INTO recording_record_receipts VALUES(?,?,?,?)').run(request.commandId,mediaFingerprint(request),JSON.stringify(request),JSON.stringify(result));
      return result;
    },
  };
}
export type RecordingRecordStore=ReturnType<typeof createRecordingRecordStore>;
