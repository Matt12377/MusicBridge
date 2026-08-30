import { isCollectionPhotoBytes } from './object-format-integrity.js';
import { verifyRecordingPrintDatabase, verifyRecordingPrintSnapshot, type RecordingPrintSnapshotBudget } from './print-integrity.js';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import type { ObjectAuditCertificateSession } from './object-audit-certificate.js';

export type RecordingRecordErrorCode = 'INVALID_REQUEST' | 'NOT_READY' | 'NOT_FOUND' | 'CONFLICT' | 'COMMAND_CONFLICT' | 'BUDGET_EXCEEDED' | 'IO_ERROR' | 'CLOSED';
export class RecordingRecordError extends Error {
  constructor(readonly code: RecordingRecordErrorCode = 'IO_ERROR') { super(`录音档案操作未完成，请核实当前资料。[${code}]`); }
}
export function recordFail(code: RecordingRecordErrorCode = 'IO_ERROR'): never { throw new RecordingRecordError(code); }
export interface RecordingContentHead { physicalId: string; revision: number; knowledge: dto.PhysicalRecordingKnowledge }
export interface RecordingContentEvent {
  source: { kind: 'begin' | 'completed' | 'legacy-completed'; attemptId: string; revision: number; recordingId?: string; recordingContentHash?: string; permitId?: string }
    | { kind: 'disposition'; disposition: dto.PhysicalRecordingDisposition };
  before: RecordingContentHead;
  after: RecordingContentHead;
  usage: string;
  physicalRevision: number;
}
export const recordTables = ['recording_records','recording_record_current','recording_record_events','recording_record_permits','recording_record_receipts','recording_record_visuals','recording_record_write_guard'] as const;
export const recordSchema = [
  'CREATE TABLE recording_records(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,attempt_revision INTEGER NOT NULL,physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),plan_id TEXT NOT NULL REFERENCES recording_plan_versions(id),data TEXT NOT NULL,FOREIGN KEY(attempt_id,attempt_revision) REFERENCES recording_attempt_events(attempt_id,revision)) STRICT',
  'CREATE TABLE recording_record_current(physical_id TEXT PRIMARY KEY REFERENCES physical_copies(physical_id),revision INTEGER NOT NULL,data TEXT NOT NULL,event_hash TEXT NOT NULL) STRICT',
  'CREATE TABLE recording_record_events(physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),revision INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(physical_id,revision)) STRICT',
  'CREATE TABLE recording_record_permits(id TEXT NOT NULL,revision INTEGER NOT NULL,physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),state TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,revision)) STRICT',
  'CREATE TABLE recording_record_receipts(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL) STRICT',
  'CREATE TABLE recording_record_visuals(sha256 TEXT PRIMARY KEY,content BLOB NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL) STRICT',
  'CREATE TABLE recording_record_write_guard(physical_id TEXT PRIMARY KEY,action TEXT NOT NULL) STRICT',
  ...['recording_records','recording_record_events','recording_record_permits','recording_record_receipts','recording_record_visuals'].flatMap(table => [
    `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'录音档案历史不可改写'); END`,
    `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'录音档案历史不可删除'); END`,
  ]),
  "CREATE TRIGGER recording_record_current_no_delete BEFORE DELETE ON recording_record_current BEGIN SELECT RAISE(ABORT,'当前内容历史不可删除'); END",
  "CREATE TRIGGER recording_record_permit_media_guard BEFORE UPDATE ON media_plans WHEN EXISTS(SELECT 1 FROM recording_record_permits p WHERE json_extract(p.data,'$.mediaPlanId')=OLD.id AND p.state='available' AND NOT EXISTS(SELECT 1 FROM recording_record_permits q WHERE q.id=p.id AND q.revision>p.revision) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard g WHERE g.physical_id=p.physical_id)) BEGIN SELECT RAISE(ABORT,'重录许可的目标规划不可自动改版'); END",
  "CREATE TRIGGER recording_record_content_copy_guard BEFORE UPDATE OF usage ON physical_copies WHEN NEW.usage<>OLD.usage AND EXISTS(SELECT 1 FROM recording_record_current WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'已有内容认知的实体须经明确处置'); END",
  "CREATE TRIGGER recording_record_permit_copy_guard BEFORE UPDATE ON physical_copies WHEN EXISTS(SELECT 1 FROM recording_record_permits p WHERE p.physical_id=OLD.physical_id AND p.state='available' AND NOT EXISTS(SELECT 1 FROM recording_record_permits q WHERE q.id=p.id AND q.revision>p.revision)) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'重录许可尚未处置'); END",
] as const;
export const recordingAttempt20Protection = [
  "CREATE TRIGGER recording_attempt_copy_no_blank BEFORE UPDATE OF usage ON physical_copies WHEN NEW.usage<>OLD.usage AND EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体状态须经明确处置'); END",
  "CREATE TRIGGER recording_attempt_reservation_no_delete BEFORE DELETE ON media_reservations WHEN EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体占用须经明确处置'); END",
  "CREATE TRIGGER recording_attempt_reservation_no_rebind BEFORE UPDATE ON media_reservations WHEN EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) AND NOT EXISTS(SELECT 1 FROM recording_record_write_guard WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体占用不可自动改绑'); END",
] as const;
export function readRecordingRecord(db: DatabaseSync, id: string): dto.RecordingRecord | null {
  const row = db.prepare('SELECT * FROM recording_records WHERE id=?').get(id); if (!row) return null;
  if (Buffer.byteLength(String(row.data)) > 128 * 1024) return recordFail();
  const value = JSON.parse(String(row.data)) as dto.RecordingRecord;
  if (!dto.isRecordingRecord(value)) return recordFail();
  const { contentHash, ...body } = value;
  if (mediaFingerprint(body) !== contentHash || value.id !== row.id || value.completion.id !== row.attempt_id || value.completion.revision !== row.attempt_revision || value.completion.physicalId !== row.physical_id || value.completion.planVersionId !== row.plan_id) return recordFail();
  return value;
}
export function readContentHead(db: DatabaseSync, physicalId: string): RecordingContentHead {
  const row = db.prepare('SELECT * FROM recording_record_current WHERE physical_id=?').get(physicalId);
  if (!row) return { physicalId, revision: 0, knowledge: { state: 'unknown', reason: 'unverified' } };
  const value = JSON.parse(String(row.data)) as RecordingContentHead;
  if (value.physicalId !== physicalId || value.revision !== row.revision) return recordFail();
  const event = db.prepare('SELECT data,event_hash FROM recording_record_events WHERE physical_id=? AND revision=?').get(physicalId,value.revision);
  if (!event || event.event_hash !== row.event_hash || mediaFingerprint((JSON.parse(String(event.data)) as RecordingContentEvent).after) !== mediaFingerprint(value)) return recordFail();
  return value;
}
export function availableRecordingPermit(db: DatabaseSync, physicalId: string): dto.RerecordPermit | null {
  const rows = db.prepare("SELECT p.data FROM recording_record_permits p WHERE p.physical_id=? AND p.state='available' AND NOT EXISTS(SELECT 1 FROM recording_record_permits q WHERE q.id=p.id AND q.revision>p.revision)").all(physicalId);
  if (rows.length > 1) return recordFail();
  const value = rows[0] ? JSON.parse(String(rows[0].data)) as dto.RerecordPermit : null;
  if (value && !dto.isRerecordPermit(value)) return recordFail(); return value;
}
type LatestAttemptRow = { id: unknown; revision: unknown; status: unknown };
function physicalRecordingState(db: DatabaseSync, physicalId: string, latest: LatestAttemptRow | null): dto.PhysicalRecordingState {
  const copy = db.prepare('SELECT revision FROM physical_copies WHERE physical_id=?').get(physicalId); if (!copy) return recordFail('NOT_FOUND');
  const value = { ...readContentHead(db,physicalId), physicalRevision: Number(copy.revision), latestAttempt: latest ? { id: String(latest.id), revision: Number(latest.revision), status: latest.status as dto.RecordingAttemptStatus } : null, activeRerecordPermit: availableRecordingPermit(db,physicalId) };
  if (!dto.isPhysicalRecordingState(value)) return recordFail(); return value;
}
export function readPhysicalRecordingState(db: DatabaseSync, physicalId: string): dto.PhysicalRecordingState {
  const latest=db.prepare('SELECT id,revision,status FROM recording_attempts WHERE physical_id=? ORDER BY rowid DESC LIMIT 1').get(physicalId) as LatestAttemptRow|undefined;
  return physicalRecordingState(db,physicalId,latest??null);
}
export function withPhysicalRecordingMutation<T>(db: DatabaseSync, physicalId: string, action: string, fn: () => T): T {
  db.prepare('INSERT INTO recording_record_write_guard VALUES(?,?)').run(physicalId,action);
  try { return fn(); } finally { db.prepare('DELETE FROM recording_record_write_guard WHERE physical_id=?').run(physicalId); }
}
export function checkRecordingRecordBudgets(db: DatabaseSync, metadata = dto.MAX_RECORDING_RECORD_METADATA_BYTES, visuals = dto.MAX_RECORDING_RECORD_VISUAL_OBJECT_BYTES): void {
  let bytes = 0;
  for (const [table, columns] of [['recording_records',['data']],['recording_record_current',['data']],['recording_record_events',['data']],['recording_record_permits',['data']],['recording_record_receipts',['request','result']]] as const) {
    const row = db.prepare(`SELECT count(*) n,COALESCE(sum(${columns.map(c => `length(CAST(${c} AS BLOB))`).join('+')}),0) bytes FROM ${table}`).get()!;
    if (Number(row.n) > 100_000) return recordFail('BUDGET_EXCEEDED'); bytes += Number(row.bytes);
  }
  if (bytes > metadata || Number(db.prepare('SELECT COALESCE(sum(length(content)),0) n FROM recording_record_visuals').get()!.n) > visuals) return recordFail('BUDGET_EXCEEDED');
}

/** schema20的重录预留只认可精确许可；旧普通预留路径不获得此能力。 */
export function recordingPermitMatchesPlan(db: DatabaseSync, physicalId: string, planId: string, mediaRevision: number): boolean {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) < 20) return false;
  const permit = availableRecordingPermit(db,physicalId), copy = db.prepare('SELECT revision FROM physical_copies WHERE physical_id=?').get(physicalId), head=readContentHead(db,physicalId);
  return !!permit && permit.state==='available' && permit.mediaPlanId===planId && permit.mediaPlanRevision===mediaRevision && permit.physicalRevision===copy?.revision && permit.contentRevision===head.revision;
}

/** B面继续读取同一冻结计划时，已消费许可必须属于当前活动Attempt，不能当成新Begin许可。 */
export function recordingReservationMatchesPlan(db: DatabaseSync, physicalId: string, planId: string, mediaRevision: number): boolean {
  if (recordingPermitMatchesPlan(db,physicalId,planId,mediaRevision)) return true;
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) < 20) return false;
  const row=db.prepare("SELECT p.data FROM recording_record_permits p JOIN recording_attempts a ON a.id=json_extract(p.data,'$.attemptId') WHERE p.physical_id=? AND p.state='consumed' AND a.status='in-progress' AND a.plan_id=json_extract(p.data,'$.planVersionId') ORDER BY p.rowid DESC LIMIT 1").get(physicalId);
  if(!row) return false;
  const permit=JSON.parse(String(row.data)) as dto.RerecordPermit;
  return dto.isRerecordPermit(permit) && permit.state==='consumed' && permit.mediaPlanId===planId && permit.mediaPlanRevision===mediaRevision;
}

/** 不依赖处置服务：按不可变事件/首次完成/许可闭包核验，不通过修复生成合法历史。 */
export function verifyRecordingRecordDatabase(db: DatabaseSync): void {
  verifyRecordDatabase(db);
}
export type RecordingRecordSnapshotBudget = RecordingPrintSnapshotBudget;
/** Attempt事务审计专用：局部Print结果在本次同步调用结束前丢弃，公开校验不启用。 */
export function verifyRecordingRecordSnapshot(db: DatabaseSync, budget: RecordingRecordSnapshotBudget = {}, certificate?: ObjectAuditCertificateSession): void {
  if (!db.isTransaction) return recordFail('INVALID_REQUEST');
  verifyRecordDatabase(db,budget,certificate);
}
function verifyRecordDatabase(db: DatabaseSync, snapshotBudget?: RecordingRecordSnapshotBudget, certificate?: ObjectAuditCertificateSession): void {
  try {
    const objects=db.prepare("SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_record*'").all();
    if (objects.length!==recordSchema.length || objects.some(row=>!recordSchema.includes(String(row.sql)))) return recordFail();
    if (db.prepare('SELECT 1 FROM recording_record_write_guard').get() || db.prepare('PRAGMA foreign_key_check').get()) return recordFail();
    checkRecordingRecordBudgets(db);
    if(Number(db.prepare('PRAGMA user_version').get()?.user_version)>=21||certificate?.requiresPrintAudit){if(snapshotBudget)verifyRecordingPrintSnapshot(db,snapshotBudget,certificate);else verifyRecordingPrintDatabase(db);}
    const latestAttempts=new Map<string,LatestAttemptRow>();
    for(const row of db.prepare('SELECT physical_id,id,revision,status FROM recording_attempts ORDER BY rowid').iterate())latestAttempts.set(String(row.physical_id),row as LatestAttemptRow);
    const referencedVisuals=new Set<string>();
    for(const row of db.prepare('SELECT id FROM recording_records').iterate()) {
      const record=readRecordingRecord(db,String(row.id))!, completed=db.prepare("SELECT revision,data FROM recording_attempt_events WHERE attempt_id=? AND json_extract(data,'$.after.status')='completed' ORDER BY revision LIMIT 1").get(record.completion.id);
      if(!completed || completed.revision!==record.completion.revision || mediaFingerprint((JSON.parse(String(completed.data)) as {after:unknown}).after)!==mediaFingerprint(record.completion)) return recordFail();
      const planRow=db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(record.completion.planVersionId); if(!planRow) return recordFail();
      const plan=JSON.parse(String(planRow.data)) as dto.RecordingPlanVersion; if(!dto.isRecordingPlanVersion(plan)) return recordFail();
      if(!dto.isRecordingRecordDetail({record,plan,current:physicalRecordingState(db,record.completion.physicalId,latestAttempts.get(record.completion.physicalId)??null)})) return recordFail();
      if(record.visuals.photos.state==='captured') for(const attachment of record.visuals.photos.attachments) {
        const visual=db.prepare('SELECT length(content) size,typeof(content) storage,width,height FROM recording_record_visuals WHERE sha256=?').get(attachment.sha256);
        if(!visual || visual.storage!=='blob' || visual.size!==attachment.size || visual.width!==attachment.width || visual.height!==attachment.height) return recordFail();
        referencedVisuals.add(attachment.sha256);
      }
    }
    for(const row of db.prepare('SELECT sha256,length(content) size,typeof(content) storage,width,height FROM recording_record_visuals').iterate()) {
      const sha256=String(row.sha256),metadata={scope:'record-visual' as const,sha256,size:Number(row.size),storage:String(row.storage),width:row.width===null?null:Number(row.width),height:row.height===null?null:Number(row.height)};
      if(!referencedVisuals.has(sha256)||metadata.storage!=='blob'||!Number.isSafeInteger(metadata.size)||metadata.size<0)return recordFail();
      if(certificate?.matchesObject(metadata))continue;
      const raw=db.prepare('SELECT content FROM recording_record_visuals WHERE sha256=?').get(sha256)?.content;
      const bytes=raw; if(!(bytes instanceof Uint8Array) || bytes.byteLength!==metadata.size || !isCollectionPhotoBytes(bytes,metadata.width,metadata.height)) return recordFail();
      // mediaFingerprint用于JSON，照片必须按原始字节SHA-256校验。
      if(hashBytes(bytes)!==sha256) return recordFail();certificate?.observeObject(metadata);
    }
    for(const row of db.prepare('SELECT * FROM recording_record_current').iterate()) {
      const physicalId=String(row.physical_id); let before:RecordingContentHead={physicalId,revision:0,knowledge:{state:'unknown',reason:'unverified'}}, previousHash=''; let last:RecordingContentEvent|undefined;
      for(const item of db.prepare('SELECT * FROM recording_record_events WHERE physical_id=? ORDER BY revision').iterate(physicalId)) {
        if(Buffer.byteLength(String(item.data))>512*1024) return recordFail();
        const event=JSON.parse(String(item.data)) as RecordingContentEvent;
        if(Object.keys(event).sort().join(',')!=='after,before,physicalRevision,source,usage' || mediaFingerprint(event.before)!==mediaFingerprint(before) || event.after.physicalId!==physicalId || event.after.revision!==before.revision+1 || event.after.revision!==item.revision || event.source.kind!==item.kind || item.previous_hash!==previousHash) return recordFail();
        const hash=mediaFingerprint({physicalId,revision:item.revision,previousHash,data:event}); if(hash!==item.event_hash) return recordFail();
        validateContentEvent(db,event); before=event.after; previousHash=hash; last=event;
      }
      if(!last || row.revision!==before.revision || mediaFingerprint(before)!==mediaFingerprint(JSON.parse(String(row.data))) || row.event_hash!==previousHash) return recordFail();
      const copy=db.prepare('SELECT usage,revision FROM physical_copies WHERE physical_id=?').get(physicalId);
      if(!copy || copy.usage!==last.usage || Number(copy.revision)<last.physicalRevision) return recordFail();
      physicalRecordingState(db,physicalId,latestAttempts.get(physicalId)??null);
    }
    if(db.prepare('SELECT 1 FROM recording_record_events e WHERE NOT EXISTS(SELECT 1 FROM recording_record_current c WHERE c.physical_id=e.physical_id) LIMIT 1').get()) return recordFail();
    for(const row of db.prepare('SELECT * FROM recording_record_permits ORDER BY id,revision').iterate()) validatePermit(db,row);
    for(const row of db.prepare('SELECT * FROM recording_record_receipts').iterate()) {
      const request=JSON.parse(String(row.request)), result=JSON.parse(String(row.result));
      if(!dto.isApplyPhysicalRecordingDispositionRequest(request) || !dto.isApplyPhysicalRecordingDispositionResult(result) || request.commandId!==row.command_id || mediaFingerprint(request)!==row.fingerprint) return recordFail();
      const event=db.prepare('SELECT data FROM recording_record_events WHERE physical_id=? AND revision=?').get(request.physicalId,result.disposition.afterContentRevision);
      if(!event || mediaFingerprint((JSON.parse(String(event.data)) as RecordingContentEvent).source)!==mediaFingerprint({kind:'disposition',disposition:result.disposition})) return recordFail();
      if(result.disposition.physicalId!==request.physicalId || mediaFingerprint(result.disposition.intent)!==mediaFingerprint(request.intent) || result.disposition.beforeContentRevision!==request.expectedContentRevision || result.disposition.beforePhysicalRevision!==request.expectedPhysicalRevision || mediaFingerprint(result.disposition.observedAttempt)!==mediaFingerprint(request.expectedAttempt)) return recordFail();
    }
    if(db.prepare("SELECT 1 FROM recording_attempts a WHERE a.status='completed' AND NOT EXISTS(SELECT 1 FROM recording_records r WHERE r.attempt_id=a.id) LIMIT 1").get()) return recordFail();
  } catch(error) { if(error instanceof RecordingRecordError) throw error; return recordFail(); }
}
import { createHash } from 'node:crypto';
export const hashBytes=(bytes:Uint8Array):string=>createHash('sha256').update(bytes).digest('hex');
function validateContentEvent(db:DatabaseSync,event:RecordingContentEvent):void {
  const source=event.source, knowledge=event.after.knowledge;
  if(source.kind==='disposition') {
    const disposition=source.disposition;
    if(!dto.isPhysicalRecordingDisposition(disposition) || disposition.physicalId!==event.after.physicalId || disposition.beforeContentRevision!==event.before.revision || disposition.afterContentRevision!==event.after.revision || disposition.afterPhysicalRevision!==event.physicalRevision) return recordFail();
    const action=disposition.intent.action;
    if(action==='mark-content-unknown' && (knowledge.state!=='unknown' || knowledge.reason!=='manual-unknown')) return recordFail();
    if(action==='confirm-erased' && (knowledge.state!=='erased' || knowledge.dispositionId!==disposition.id || event.usage!=='erased')) return recordFail();
    if(action==='confirm-current-recording') {
      const record=readRecordingRecord(db,disposition.intent.recordingId);
      if(!record || record.completion.physicalId!==event.after.physicalId || knowledge.state!=='confirmed-recording' || knowledge.recordingId!==record.id || knowledge.evidence.kind!=='manual-disposition' || knowledge.evidence.dispositionId!==disposition.id) return recordFail();
    }
    if(action==='prepare-rerecord' && (event.usage!=='reserved' || mediaFingerprint(knowledge)!==mediaFingerprint(event.before.knowledge))) return recordFail();
    if(action==='cancel-rerecord' && (event.usage==='blank' || event.usage==='reserved' || mediaFingerprint(knowledge)!==mediaFingerprint(event.before.knowledge))) return recordFail();
    if(!db.prepare("SELECT 1 FROM recording_record_receipts WHERE json_extract(result,'$.disposition.id')=?").get(disposition.id)) return recordFail();
    return;
  }
  const attemptRow=db.prepare('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(source.attemptId,source.revision);
  if(!attemptRow) return recordFail(); const attempt=(JSON.parse(String(attemptRow.data)) as {after:dto.RecordingAttempt}).after;
  if(attempt.physicalId!==event.after.physicalId) return recordFail();
  if(source.kind==='begin') {
    if(source.revision!==1 || attempt.status!=='in-progress' || knowledge.state!=='unknown' || knowledge.reason!=='new-attempt' || event.usage!=='reserved') return recordFail();
    if(source.permitId) {
      const p=db.prepare('SELECT data FROM recording_record_permits WHERE id=? AND revision=2').get(source.permitId), permit=p?JSON.parse(String(p.data)) as dto.RerecordPermit:null;
      if(!permit || permit.state!=='consumed' || permit.attemptId!==attempt.id) return recordFail();
    }
  } else {
    const record=source.recordingId?readRecordingRecord(db,source.recordingId):null;
    if(!record || source.recordingContentHash!==record.contentHash || record.completion.id!==attempt.id || record.completion.revision!==attempt.revision || knowledge.state!=='confirmed-recording' || knowledge.recordingId!==record.id || knowledge.evidence.kind!=='completed-attempt' || knowledge.evidence.attemptId!==attempt.id || knowledge.evidence.revision!==attempt.revision) return recordFail();
    if(source.kind==='completed' && (record.media.snapshotSource!=='completion' || event.usage!=='recorded')) return recordFail();
    if(source.kind==='legacy-completed' && record.media.snapshotSource!=='legacy-plan-only') return recordFail();
  }
}
function validatePermit(db:DatabaseSync,row:Record<string,unknown>):void {
  const permit=JSON.parse(String(row.data)) as dto.RerecordPermit;
  if(!dto.isRerecordPermit(permit) || permit.id!==row.id || permit.physicalId!==row.physical_id || permit.state!==row.state || row.revision!==(permit.state==='available'?1:2)) return recordFail();
  const created=db.prepare("SELECT data FROM recording_record_events WHERE physical_id=? AND revision=?").get(permit.physicalId,permit.contentRevision);
  const event=created?JSON.parse(String(created.data)) as RecordingContentEvent:null;
  if(!event || event.source.kind!=='disposition' || event.source.disposition.id!==permit.dispositionId || event.source.disposition.intent.action!=='prepare-rerecord' || event.source.disposition.permitId!==permit.id || event.source.disposition.intent.mediaPlanId!==permit.mediaPlanId || permit.mediaPlanRevision!==event.source.disposition.intent.expectedMediaPlanRevision+1 || permit.physicalRevision!==event.physicalRevision) return recordFail();
  if(permit.state==='available' && !db.prepare('SELECT 1 FROM recording_record_permits WHERE id=? AND revision=2').get(permit.id)) {
    const reservation=db.prepare('SELECT physical_id FROM media_reservations WHERE plan_id=?').get(permit.mediaPlanId);
    const media=db.prepare('SELECT revision FROM media_plans WHERE id=?').get(permit.mediaPlanId);
    const copy=db.prepare('SELECT usage,revision,reserved_from FROM physical_copies WHERE physical_id=?').get(permit.physicalId);
    if(reservation?.physical_id!==permit.physicalId || media?.revision!==permit.mediaPlanRevision || copy?.usage!=='reserved' || copy.revision!==permit.physicalRevision || !['recorded','unknown','erased'].includes(String(copy.reserved_from)) || readContentHead(db,permit.physicalId).revision!==permit.contentRevision) return recordFail();
  }
  if(permit.state!=='available') {
    const original=db.prepare('SELECT data FROM recording_record_permits WHERE id=? AND revision=1').get(permit.id); if(!original) return recordFail();
    const prior=JSON.parse(String(original.data)) as dto.RerecordPermit;
    for(const key of ['id','physicalId','dispositionId','createdAt','mediaPlanId','mediaPlanRevision','contentRevision','physicalRevision','precedingAttempt'] as const) if(mediaFingerprint(prior[key])!==mediaFingerprint(permit[key])) return recordFail();
    if(permit.state==='consumed') {
      const begin=db.prepare('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=1').get(permit.attemptId); if(!begin) return recordFail();
      const after=(JSON.parse(String(begin.data)) as {after:dto.RecordingAttempt}).after;
      if(after.physicalId!==permit.physicalId || after.planVersionId!==permit.planVersionId || after.planContentHash!==permit.planContentHash) return recordFail();
    } else if(!db.prepare("SELECT 1 FROM recording_record_receipts WHERE json_extract(result,'$.disposition.id')=? AND json_extract(request,'$.intent.permitId')=?").get(permit.dispositionIdOfRevocation,permit.id)) return recordFail();
  }
}
