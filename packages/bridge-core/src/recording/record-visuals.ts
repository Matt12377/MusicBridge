import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { hashBytes, readRecordingRecord, recordFail } from './record-integrity.js';

export function captureRecordingVisuals(db:DatabaseSync, recordingId:string, physicalId:string, legacy=false, onInsert?:()=>void):dto.RecordingVisualSnapshotV1 {
  const absent={state:'not-captured',reason:'not-provided'} as const;
  if(legacy) return {artwork:absent,jCard:absent,photos:absent};
  const rows=db.prepare('SELECT * FROM collection_photos WHERE physical_id=? ORDER BY rowid').all(physicalId);
  if(rows.length>dto.MAX_RECORDING_RECORD_VISUALS) return recordFail('BUDGET_EXCEEDED');
  const attachments:dto.RecordingVisualAttachment[]=rows.map(row=>{
    const bytes=row.content;
    if(!(bytes instanceof Uint8Array) || !dto.isCollectionPhotoImage({dataUrl:`data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`,width:row.width,height:row.height}) || hashBytes(bytes)!==row.content_hash) return recordFail();
    const sha256=String(row.content_hash), prior=db.prepare('SELECT content,width,height FROM recording_record_visuals WHERE sha256=?').get(sha256);
    if(prior && (!(prior.content instanceof Uint8Array) || !Buffer.from(prior.content).equals(Buffer.from(bytes)) || prior.width!==row.width || prior.height!==row.height)) return recordFail();
    if(!prior) { db.prepare('INSERT INTO recording_record_visuals VALUES(?,?,?,?)').run(sha256,bytes,Number(row.width),Number(row.height));onInsert?.(); }
    return {id:randomUUID(),recordingId,sourcePhotoId:String(row.id),physicalId,role:'photo',source:'physical-photo',sha256,size:bytes.length,mimeType:'image/jpeg',width:Number(row.width),height:Number(row.height)};
  });
  return {artwork:{state:'not-captured',reason:'not-implemented'},jCard:{state:'not-captured',reason:'not-implemented'},photos:attachments.length?{state:'captured',attachments}:absent};
}
export function readRecordingVisual(db:DatabaseSync,request:dto.RecordingVisualRequest):dto.RecordingVisualResult {
  if(!dto.isRecordingVisualRequest(request)) return recordFail('INVALID_REQUEST');
  const record=readRecordingRecord(db,request.recordingId), attachment=record?.visuals.photos.state==='captured'?record.visuals.photos.attachments.find(v=>v.id===request.attachmentId):undefined;
  if(!attachment) return recordFail('NOT_FOUND');
  const row=db.prepare('SELECT * FROM recording_record_visuals WHERE sha256=?').get(attachment.sha256),bytes=row?.content;
  if(!(bytes instanceof Uint8Array) || hashBytes(bytes)!==attachment.sha256 || bytes.length!==attachment.size || row!.width!==attachment.width || row!.height!==attachment.height) return recordFail();
  const result={recordingId:request.recordingId,attachmentId:request.attachmentId,sha256:attachment.sha256,image:{dataUrl:`data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`,width:attachment.width,height:attachment.height}};
  if(!dto.isRecordingVisualResult(result)) return recordFail(); return result;
}
