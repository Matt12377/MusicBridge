import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { createRecordingPrintRequest } from './print-facts.js';
import { RecordingPrintError,printFail,printHash,printSchema,printImage,printObject,printParse,printJob,printRecordPlan,checkPrintBudgets,verifyRecordingPrintDatabase,type RecordingPrintBudgets,type PrintLeaseIdentity,type PrintEvent } from './print-integrity.js';
import { verifyRecordingRecordSnapshot, type RecordingRecordSnapshotBudget } from './record-integrity.js';
import { createObjectAuditCertificateManager, type ObjectAuditCertificateAction, type ObjectAuditCertificateManager, type ObjectAuditCertificateSession } from './object-audit-certificate.js';
interface Access extends RecordingPrintBudgets {read<T>(fn:(db:DatabaseSync)=>T):T;beforeCommit?:(action:string)=>void;objectAudit?:RecordingRecordSnapshotBudget;objectCertificates?:ObjectAuditCertificateManager}
const now=()=>new Date().toISOString();
function append(db:DatabaseSync,job:dto.RecordingPrintJob,kind:string,lease:PrintLeaseIdentity|null=null):void{
 if(!dto.isRecordingPrintJob(job))printFail();
 const previousHash=job.revision===1?'':String(db.prepare('SELECT event_hash FROM recording_print_events WHERE job_id=? AND revision=?').get(job.id,job.revision-1)?.event_hash??'');
 if(job.revision>1&&!previousHash)printFail();
 const data:PrintEvent={job,lease},hash=mediaFingerprint({jobId:job.id,revision:job.revision,kind,previousHash,data});
 db.prepare('INSERT INTO recording_print_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,lease=excluded.lease').run(job.id,job.request.id,JSON.stringify(job),lease?JSON.stringify(lease):null);
 db.prepare('INSERT INTO recording_print_events VALUES(?,?,?,?,?,?)').run(job.id,job.revision,kind,JSON.stringify(data),previousHash,hash);
}
function putObject(db:DatabaseSync,bytes:Buffer,mime:'image/jpeg'|'application/pdf',width:number|null=null,height:number|null=null):{sha256:string;inserted:boolean}{
 const sha=printHash(bytes),prior=db.prepare('SELECT * FROM recording_print_objects WHERE sha256=?').get(sha);
 if(prior){const object=printObject(db,sha);if(object.mime!==mime||object.width!==width||object.height!==height||!object.bytes.equals(bytes))printFail();}
 else db.prepare('INSERT INTO recording_print_objects VALUES(?,?,?,?,?)').run(sha,mime,bytes,width,height);
 return {sha256:sha,inserted:!prior};
}
function receipt<T>(db:DatabaseSync,id:string,kind:string,request:unknown,result:T,storedRequest:unknown=request):T{
 db.prepare('INSERT INTO recording_print_receipts VALUES(?,?,?,?,?)').run(id,kind,mediaFingerprint(request),JSON.stringify(storedRequest),JSON.stringify(result));return result;
}
function cached<T>(db:DatabaseSync,id:string,kind:string,request:unknown):T|undefined{
 const row=db.prepare('SELECT * FROM recording_print_receipts WHERE id=?').get(id);if(!row)return undefined;
 if(row.kind!==kind||row.fingerprint!==mediaFingerprint(request))printFail('COMMAND_CONFLICT');return JSON.parse(String(row.result)) as T;
}
export function captureMasterArtwork(db:DatabaseSync,masterVersionId:string):dto.RecordingArtworkSnapshot{
 const row=db.prepare('SELECT v.data FROM master_artwork_current c JOIN master_artwork_versions v ON v.id=c.version_id WHERE c.master_id=?').get(masterVersionId);
 if(!row)return {state:'not-captured',reason:'not-provided'};
 const version=printParse(row.data,dto.isMasterArtworkVersion);printImage(db,version.sha256);return {state:'captured',version};
}
/** 首次Completed事务内调用；打印意图与档案一起提交，渲染在另一个明确生命周期内。 */
export function registerRecordingPrint(db:DatabaseSync,record:dto.RecordingRecord,plan:dto.RecordingPlanVersion,id:string,origin:dto.RecordingPrintRequest['origin'],createdAt:string):dto.RecordingPrintJob{
 const {request,facts}=createRecordingPrintRequest({id,record,plan,origin,createdAt});
 db.prepare('INSERT INTO recording_print_requests VALUES(?,?,?,?)').run(id,record.id,JSON.stringify(request),JSON.stringify(facts));
 const job:dto.RecordingPrintJob={id:randomUUID(),request,state:'pending',revision:1,createdAt,updatedAt:createdAt,artifactId:null,errorCode:null};append(db,job,'create');checkPrintBudgets(db);return job;
}
export function migrateRecordingPrints(db:DatabaseSync):void {for(const sql of printSchema)db.exec(sql);db.exec('PRAGMA user_version=21');verifyRecordingPrintDatabase(db);}
/** 仅新Core启动/隔离恢复调用。先校验历史，再恢复打印，不触碰任何录音或输出。 */
export function recoverRecordingPrints(db:DatabaseSync):void{
 verifyRecordingPrintDatabase(db);
 for(const row of db.prepare("SELECT id FROM recording_print_jobs WHERE json_extract(data,'$.state')='rendering'").all()){
  const previous=printJob(db,String(row.id));append(db,{...previous,state:'pending',revision:previous.revision+1,updatedAt:now()},'recover');
 }
 verifyRecordingPrintDatabase(db);
}
export function createRecordingPrintStore(access:Access){
 const objectCertificates=access.objectCertificates??createObjectAuditCertificateManager(access.beforeCommit!==undefined);
 function transaction<T>(action:string,certificateAction:ObjectAuditCertificateAction,fn:(db:DatabaseSync,certificate?:ObjectAuditCertificateSession)=>T):T{
  return access.read(db=>{
   try{db.exec('BEGIN IMMEDIATE');}catch(error){objectCertificates.clear(db);throw error;}
   const optimized=access.beforeCommit===undefined&&['print-claim','print-complete'].includes(certificateAction),certificate=objectCertificates.begin(db,optimized?certificateAction:'other');
   try{
    if(optimized){if(!certificate.reuseSnapshot()){verifyRecordingRecordSnapshot(db,access.objectAudit,certificate);certificate.observeSnapshotVerified();}}
    else verifyRecordingPrintDatabase(db);
    const result=fn(db,optimized?certificate:undefined);checkPrintBudgets(db,access);
    // claim只追加已局部验证的投影/事件；complete必须在提交前核验新对象、artifact、事件和receipt闭包。
    if(optimized&&certificateAction==='print-complete'){verifyRecordingRecordSnapshot(db,access.objectAudit,certificate);certificate.observeSnapshotVerified();}
    else if(!optimized)verifyRecordingPrintDatabase(db);
    access.beforeCommit?.(action);
    if(access.beforeCommit!==undefined)verifyRecordingPrintDatabase(db);
    let candidate=optimized?certificate.candidate():null;
    if(optimized&&!candidate){verifyRecordingRecordSnapshot(db,access.objectAudit);candidate=null;}
    db.exec('COMMIT');objectCertificates.publish(db,candidate);return result;
   }catch(error){objectCertificates.clear(db);if(db.isTransaction)try{db.exec('ROLLBACK');}catch{/* 保留原始故障 */}if(error instanceof RecordingPrintError)throw error;return printFail();}
  });
 }
 function matchLease(db:DatabaseSync,request:Pick<dto.FailRecordingPrintRequest,'jobId'|'leaseId'|'workerId'|'inputHash'>):dto.RecordingPrintJob{
  const job=printJob(db,request.jobId),row=db.prepare('SELECT lease FROM recording_print_jobs WHERE id=?').get(job.id);const lease:PrintLeaseIdentity|null=row?.lease?JSON.parse(String(row.lease)):null;
  if(job.state!=='rendering'||!lease||lease.leaseId!==request.leaseId||lease.workerId!==request.workerId||lease.inputHash!==request.inputHash)printFail('CONFLICT');return job;
 }
 return {
  artworkGet(request:dto.GetMasterArtworkRequest):dto.MasterArtworkResult{
   if(!dto.isGetMasterArtworkRequest(request))printFail('INVALID_REQUEST');return access.read(db=>{
    if(!db.prepare('SELECT 1 FROM master_versions WHERE id=?').get(request.masterVersionId))printFail('NOT_FOUND');
    const current=captureMasterArtwork(db,request.masterVersionId),currentVersion=current.state==='captured'?current.version:null;
    const selected=request.versionId?db.prepare('SELECT data FROM master_artwork_versions WHERE id=? AND master_id=?').get(request.versionId,request.masterVersionId):undefined;
    if(request.versionId&&!selected)printFail('NOT_FOUND');const version=request.versionId?printParse(selected!.data,dto.isMasterArtworkVersion):currentVersion;
    return {masterVersionId:request.masterVersionId,currentVersion,version,image:version?printImage(db,version.sha256):null};
   });
  },
  artworkSave(request:dto.SaveMasterArtworkRequest):dto.MasterArtworkVersion{
   if(!dto.isSaveMasterArtworkRequest(request))printFail('INVALID_REQUEST');return transaction('save-master-artwork','other',db=>{
    const prior=cached<dto.MasterArtworkVersion>(db,`command:${request.commandId}`,'artwork',request);if(prior)return prior;
    if(!db.prepare('SELECT 1 FROM master_versions WHERE id=?').get(request.masterVersionId))printFail('NOT_FOUND');
    const snapshot=captureMasterArtwork(db,request.masterVersionId),current=snapshot.state==='captured'?snapshot.version:null;
    if((current?.id??null)!==request.expectedVersionId)printFail('CONFLICT');if((current?.sequence??0)>=dto.MAX_MASTER_ARTWORK_VERSIONS)printFail('BUDGET_EXCEEDED');
    const bytes=Buffer.from(request.image.dataUrl.slice(23),'base64'),{sha256}=putObject(db,bytes,'image/jpeg',request.image.width,request.image.height);
    const version:dto.MasterArtworkVersion={id:randomUUID(),masterVersionId:request.masterVersionId,sequence:(current?.sequence??0)+1,createdAt:now(),sha256,size:bytes.length,width:request.image.width,height:request.image.height,mimeType:'image/jpeg'};
    db.prepare('INSERT INTO master_artwork_versions VALUES(?,?,?,?,?)').run(version.id,version.masterVersionId,version.sequence,sha256,JSON.stringify(version));
    db.prepare('INSERT INTO master_artwork_current VALUES(?,?) ON CONFLICT(master_id) DO UPDATE SET version_id=excluded.version_id').run(version.masterVersionId,version.id);
    const {image:_,...identity}=request;return receipt(db,`command:${request.commandId}`,'artwork',request,version,identity);
   });
  },
  list(request:dto.ListRecordingPrintsRequest):dto.RecordingPrintsPage{
   if(!dto.isListRecordingPrintsRequest(request))printFail('INVALID_REQUEST');return access.read(db=>{
    printRecordPlan(db,request.recordingId);const total=Number(db.prepare('SELECT count(*) n FROM recording_print_requests WHERE recording_id=?').get(request.recordingId)!.n);
    const items=db.prepare('SELECT j.data FROM recording_print_jobs j JOIN recording_print_requests r ON r.id=j.request_id WHERE r.recording_id=? ORDER BY j.rowid DESC LIMIT ? OFFSET ?').all(request.recordingId,request.page.limit,request.page.offset).map(row=>printParse(row.data,dto.isRecordingPrintJob));
    return {...request.page,total,items,hasMore:request.page.offset+items.length<total};
   });
  },
  request(request:dto.RequestRecordingPrintRequest):dto.RecordingPrintJob{
   if(!dto.isRequestRecordingPrintRequest(request))printFail('INVALID_REQUEST');return transaction('request-recording-print','other',db=>{
    const prior=cached<dto.RecordingPrintJob>(db,`command:${request.commandId}`,'request',request);if(prior)return prior;
    const {record,plan}=printRecordPlan(db,request.recordingId);if(record.contentHash!==request.expectedRecordHash)printFail('CONFLICT');if(plan.layout.spec.format!=='cassette')printFail('NOT_APPLICABLE');
    const existing=db.prepare('SELECT j.id FROM recording_print_jobs j JOIN recording_print_requests r ON r.id=j.request_id WHERE r.recording_id=?').get(record.id);
    const job=existing?printJob(db,String(existing.id)):registerRecordingPrint(db,record,plan,randomUUID(),'historical-backfill',now());
    return receipt(db,`command:${request.commandId}`,'request',request,job);
   });
  },
  retry(request:dto.RetryRecordingPrintRequest):dto.RecordingPrintJob{
   if(!dto.isRetryRecordingPrintRequest(request))printFail('INVALID_REQUEST');return transaction('retry-recording-print','other',db=>{
    const prior=cached<dto.RecordingPrintJob>(db,`command:${request.commandId}`,'retry',request);if(prior)return prior;
    const job=printJob(db,request.jobId);if(job.revision!==request.expectedRevision||job.state!=='failed')printFail('CONFLICT');
    const next:dto.RecordingPrintJob={...job,state:'pending',revision:job.revision+1,updatedAt:now(),errorCode:null};append(db,next,'retry');return receipt(db,`command:${request.commandId}`,'retry',request,next);
   });
  },
  claim(request:dto.ClaimRecordingPrintRequest):{lease:dto.RecordingPrintLease|null}{
   if(!dto.isClaimRecordingPrintRequest(request))printFail('INVALID_REQUEST');
   // 无任务/已有租约仅返回空，不读取对象；真正领取仍在写事务中完整校验并再次判定。
   const actionable=access.read(db=>!db.prepare("SELECT 1 FROM recording_print_jobs WHERE json_extract(data,'$.state')='rendering' LIMIT 1").get()&&Boolean(db.prepare("SELECT 1 FROM recording_print_jobs WHERE json_extract(data,'$.state')='pending' LIMIT 1").get()));
   if(!actionable)return {lease:null};
   return transaction('claim-recording-print','print-claim',(db,certificate)=>{
    if(db.prepare("SELECT 1 FROM recording_print_jobs WHERE json_extract(data,'$.state')='rendering'").get()){certificate?.expectPrintMutations(0);return {lease:null};}
    const row=db.prepare("SELECT id FROM recording_print_jobs WHERE json_extract(data,'$.state')='pending' ORDER BY rowid LIMIT 1").get();if(!row){certificate?.expectPrintMutations(0);return {lease:null};}const job=printJob(db,String(row.id));
    const facts=printParse(db.prepare('SELECT facts FROM recording_print_requests WHERE id=?').get(job.request.id)!.facts,dto.isRecordingPrintFacts);
    const identity:PrintLeaseIdentity={leaseId:randomUUID(),workerId:request.workerId,jobId:job.id,requestId:job.request.id,inputHash:job.request.inputHash};
    append(db,{...job,state:'rendering',revision:job.revision+1,updatedAt:now()},'claim',identity);
    const lease:dto.RecordingPrintLease={...identity,facts,artworkImage:facts.artwork.state==='captured'?printImage(db,facts.artwork.version.sha256):null,templateId:job.request.templateId};if(!dto.isRecordingPrintLease(lease))printFail();certificate?.expectPrintMutations(2);return {lease};
   });
  },
  complete(request:dto.CompleteRecordingPrintRequest):dto.RecordingPrintJob{
   if(!dto.isCompleteRecordingPrintRequest(request))printFail('INVALID_REQUEST');return transaction('complete-recording-print','print-complete',(db,certificate)=>{
    const prior=cached<dto.RecordingPrintJob>(db,`lease:${request.leaseId}`,'complete',request);if(prior){certificate?.expectPrintMutations(0);return prior;}
    const job=matchLease(db,request),pdf=Buffer.from(request.pdfBase64,'base64'),preview=Buffer.from(request.preview.dataUrl.slice(23),'base64');if(printHash(pdf)!==request.pdfSha256)printFail('INVALID_REQUEST');
    const pdfObject=putObject(db,pdf,'application/pdf'),previewObject=putObject(db,preview,'image/jpeg',request.preview.width,request.preview.height),pdfSha256=pdfObject.sha256,previewSha256=previewObject.sha256;
    const facts=printParse(db.prepare('SELECT facts FROM recording_print_requests WHERE id=?').get(job.request.id)!.facts,dto.isRecordingPrintFacts);
    const artifact:dto.PrintedArtifact={id:randomUUID(),requestId:job.request.id,recordingId:job.request.recordingId,createdAt:now(),inputHash:job.request.inputHash,templateId:job.request.templateId,templateHash:job.request.templateHash,rendererVersion:request.rendererVersion,pdfSha256,size:pdf.length,pageCount:request.pageCount,geometry:structuredClone(dto.RECORDING_PRINT_GEOMETRY),previewSha256,previewSize:preview.length,artwork:facts.artwork};
    db.prepare('INSERT INTO recording_print_artifacts VALUES(?,?,?,?,?)').run(artifact.id,artifact.requestId,pdfSha256,previewSha256,JSON.stringify(artifact));
    const next:dto.RecordingPrintJob={...job,state:'ready',revision:job.revision+1,updatedAt:artifact.createdAt,artifactId:artifact.id};append(db,next,'complete');
    const {pdfBase64:_,preview:__,...identity}=request;const result=receipt(db,`lease:${request.leaseId}`,'complete',request,next,identity);
    certificate?.expectPrintMutations((4+Number(pdfObject.inserted)+Number(previewObject.inserted)) as 4|5|6);return result;
   });
  },
  fail(request:dto.FailRecordingPrintRequest):dto.RecordingPrintJob{
   if(!dto.isFailRecordingPrintRequest(request))printFail('INVALID_REQUEST');return transaction('fail-recording-print','other',db=>{
    const prior=cached<dto.RecordingPrintJob>(db,`lease:${request.leaseId}`,'fail',request);if(prior)return prior;const job=matchLease(db,request);
    const next:dto.RecordingPrintJob={...job,state:'failed',revision:job.revision+1,updatedAt:now(),errorCode:request.errorCode};append(db,next,'fail');return receipt(db,`lease:${request.leaseId}`,'fail',request,next);
   });
  },
  get(request:dto.GetRecordingPrintRequest):dto.RecordingPrintResult{
   if(!dto.isGetRecordingPrintRequest(request))printFail('INVALID_REQUEST');return access.read(db=>{
    const artifact=printParse(db.prepare("SELECT data FROM recording_print_artifacts WHERE id=? AND json_extract(data,'$.recordingId')=?").get(request.artifactId,request.recordingId)?.data,dto.isPrintedArtifact);
    const facts=printParse(db.prepare('SELECT facts FROM recording_print_requests WHERE id=?').get(artifact.requestId)?.facts,dto.isRecordingPrintFacts);
    printObject(db,artifact.pdfSha256);return {artifact,facts,preview:printImage(db,artifact.previewSha256)};
   });
  },
  pdf(request:dto.ExportRecordingPrintRequest):dto.RecordingPrintPdfResult{
   if(!dto.isExportRecordingPrintRequest(request))printFail('INVALID_REQUEST');return access.read(db=>{
    const artifact=printParse(db.prepare("SELECT data FROM recording_print_artifacts WHERE id=? AND json_extract(data,'$.recordingId')=?").get(request.artifactId,request.recordingId)?.data,dto.isPrintedArtifact);
    if(artifact.pdfSha256!==request.expectedPdfSha256)printFail('CONFLICT');const bytes=printObject(db,artifact.pdfSha256).bytes;if(bytes.length!==artifact.size)printFail();return {artifactId:artifact.id,pdfSha256:artifact.pdfSha256,size:artifact.size,pdfBase64:bytes.toString('base64')};
   });
  },
 };
}
export type RecordingPrintStore=ReturnType<typeof createRecordingPrintStore>;
