import { isMasterArtworkBytes, isRecordingPrintPdfBytes } from './object-format-integrity.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { createRecordingPrintRequest } from './print-facts.js';
import { receiptCertificateValue, type CertifiedObjectMetadata, type ObjectAuditCertificateSession } from './object-audit-certificate.js';

export type RecordingPrintErrorCode = 'INVALID_REQUEST'|'NOT_FOUND'|'NOT_APPLICABLE'|'CONFLICT'|'COMMAND_CONFLICT'|'BUDGET_EXCEEDED'|'IO_ERROR'|'CLOSED';
export class RecordingPrintError extends Error { constructor(readonly code:RecordingPrintErrorCode='IO_ERROR'){super(`印刷品操作未完成，请核实当前资料。[${code}]`);} }
export function printFail(code:RecordingPrintErrorCode='IO_ERROR'):never { throw new RecordingPrintError(code); }
export const printHash=(bytes:Uint8Array):string=>createHash('sha256').update(bytes).digest('hex');
export const printTables=['master_artwork_versions','master_artwork_current','recording_print_objects','recording_print_requests','recording_print_jobs','recording_print_events','recording_print_artifacts','recording_print_receipts'] as const;
export const printSchema=[
 'CREATE TABLE recording_print_objects(sha256 TEXT PRIMARY KEY,mime TEXT NOT NULL,content BLOB NOT NULL,width INTEGER,height INTEGER) STRICT',
 'CREATE TABLE master_artwork_versions(id TEXT PRIMARY KEY,master_id TEXT NOT NULL REFERENCES master_versions(id),sequence INTEGER NOT NULL,sha256 TEXT NOT NULL REFERENCES recording_print_objects(sha256),data TEXT NOT NULL,UNIQUE(master_id,sequence)) STRICT',
 'CREATE TABLE master_artwork_current(master_id TEXT PRIMARY KEY REFERENCES master_versions(id),version_id TEXT NOT NULL UNIQUE REFERENCES master_artwork_versions(id)) STRICT',
 'CREATE TABLE recording_print_requests(id TEXT PRIMARY KEY,recording_id TEXT NOT NULL UNIQUE REFERENCES recording_records(id),data TEXT NOT NULL,facts TEXT NOT NULL) STRICT',
 'CREATE TABLE recording_print_jobs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES recording_print_requests(id),data TEXT NOT NULL,lease TEXT) STRICT',
 'CREATE TABLE recording_print_events(job_id TEXT NOT NULL REFERENCES recording_print_jobs(id),revision INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(job_id,revision)) STRICT',
 'CREATE TABLE recording_print_artifacts(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES recording_print_requests(id),pdf_sha TEXT NOT NULL REFERENCES recording_print_objects(sha256),preview_sha TEXT NOT NULL REFERENCES recording_print_objects(sha256),data TEXT NOT NULL) STRICT',
 'CREATE TABLE recording_print_receipts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL) STRICT',
 ...['master_artwork_versions','recording_print_objects','recording_print_requests','recording_print_events','recording_print_artifacts','recording_print_receipts'].flatMap(table=>[
  `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'印刷历史不可改写'); END`,
  `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'印刷历史不可删除'); END`,
 ]),
 ...['master_artwork_current','recording_print_jobs'].map(table=>`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'印刷当前投影不可删除'); END`),
];
export interface RecordingPrintBudgets { metadataBudgetBytes?:number;objectBudgetBytes?:number;jobLimit?:number;receiptLimit?:number }
export function checkPrintBudgets(db:DatabaseSync,b:RecordingPrintBudgets={}):void {
 const values=[[b.metadataBudgetBytes,dto.MAX_RECORDING_PRINT_METADATA_BYTES],[b.objectBudgetBytes,dto.MAX_RECORDING_PRINT_OBJECT_BYTES],[b.jobLimit,dto.MAX_RECORDING_PRINT_JOBS],[b.receiptLimit,dto.MAX_RECORDING_PRINT_RECEIPTS]] as const;
 for(const [n,max] of values)if(n!==undefined&&(!Number.isSafeInteger(n)||n<1||n>max))printFail('INVALID_REQUEST');
 let bytes=0;
 for(const [table,columns] of [['master_artwork_versions',['data']],['recording_print_requests',['data','facts']],['recording_print_jobs',['data','lease']],['recording_print_events',['data']],['recording_print_artifacts',['data']],['recording_print_receipts',['request','result']]] as const){
  for(const col of columns){const row=db.prepare(`SELECT coalesce(sum(length(cast(${col} AS BLOB))),0) n,coalesce(max(length(cast(${col} AS BLOB))),0) largest FROM ${table}`).get()!;bytes+=Number(row.n);if(Number(row.largest)>dto.MAX_RECORDING_PRINT_ITEM_BYTES)printFail('BUDGET_EXCEEDED');}
 }
 if(bytes>(b.metadataBudgetBytes??dto.MAX_RECORDING_PRINT_METADATA_BYTES)||Number(db.prepare('SELECT coalesce(sum(length(content)),0) n FROM recording_print_objects').get()!.n)>(b.objectBudgetBytes??dto.MAX_RECORDING_PRINT_OBJECT_BYTES)
 ||Number(db.prepare('SELECT count(*) n FROM recording_print_jobs').get()!.n)>(b.jobLimit??dto.MAX_RECORDING_PRINT_JOBS)||Number(db.prepare('SELECT count(*) n FROM recording_print_receipts').get()!.n)>(b.receiptLimit??dto.MAX_RECORDING_PRINT_RECEIPTS))printFail('BUDGET_EXCEEDED');
}
export function printParse<T>(raw:unknown,guard:(v:unknown)=>v is T):T { if(typeof raw!=='string'||Buffer.byteLength(raw)>dto.MAX_RECORDING_PRINT_ITEM_BYTES)printFail();let value:unknown;try{value=JSON.parse(raw);}catch{return printFail();}if(!guard(value))printFail();return value; }
export function printRecordPlan(db:DatabaseSync,id:string):{record:dto.RecordingRecord;plan:dto.RecordingPlanVersion}{
 const row=db.prepare('SELECT data FROM recording_records WHERE id=?').get(id);if(!row)printFail('NOT_FOUND');
 // Record/Plan有各自已验证的较大预算，不能套打印单项预算。
 const record:unknown=JSON.parse(String(row.data));if(!dto.isRecordingRecord(record))printFail();
 const {contentHash,...body}=record;if(mediaFingerprint(body)!==contentHash)printFail();
 const planRow=db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(record.completion.planVersionId);if(!planRow)printFail();
 const plan:unknown=JSON.parse(String(planRow.data));if(!dto.isRecordingPlanVersion(plan))printFail();return {record,plan};
}
interface PrintObject {bytes:Buffer;mime:string;width:number|null;height:number|null}
interface EncodedPrintObject {bytes:Buffer|null;size:number;mime:string;width:number|null;height:number|null;base64:string|null}
function decodePrintObject(row:ReturnType<ReturnType<DatabaseSync['prepare']>['get']>,sha:string):EncodedPrintObject{
 if(!row||!(row.content instanceof Uint8Array)||printHash(row.content)!==sha)printFail();
 const bytes=Buffer.from(row.content),mime=String(row.mime),width=row.width===null?null:Number(row.width),height=row.height===null?null:Number(row.height);
 const base64=bytes.toString('base64');
 if(mime==='image/jpeg'){if(!isMasterArtworkBytes(bytes,width,height))printFail();}
 else if(mime!=='application/pdf'||width!==null||height!==null||!isRecordingPrintPdfBytes(bytes))printFail();
 return {bytes,size:bytes.length,mime,width,height,base64};
}
export function printObject(db:DatabaseSync,sha:string):PrintObject{
 const object=decodePrintObject(db.prepare('SELECT * FROM recording_print_objects WHERE sha256=?').get(sha),sha);if(!object.bytes)printFail();return {bytes:object.bytes,mime:object.mime,width:object.width,height:object.height};
}
export function printImage(db:DatabaseSync,sha:string):dto.CollectionPhotoImage{const object=printObject(db,sha);if(object.mime!=='image/jpeg')printFail();return {dataUrl:`data:image/jpeg;base64,${object.bytes.toString('base64')}`,width:object.width!,height:object.height!};}
export interface RecordingPrintSnapshotBudget {maxBytes?:number;maxEntries?:number}
interface PrintObjectAccessor {
	 get(sha:string,requireRaw?:boolean):EncodedPrintObject;receipt(row:Record<string,unknown>):boolean;observeReceipt(row:Record<string,unknown>):void;clear():void;
}
function plainObjects(db:DatabaseSync):PrintObjectAccessor{return {get:sha=>decodePrintObject(db.prepare('SELECT * FROM recording_print_objects WHERE sha256=?').get(sha),sha),receipt:()=>false,observeReceipt(){},clear(){}};}
function objectImage(object:EncodedPrintObject):dto.CollectionPhotoImage {if(object.mime!=='image/jpeg'||object.base64===null)printFail();return {dataUrl:`data:image/jpeg;base64,${object.base64}`,width:object.width!,height:object.height!};}
function certifiedMetadata(row:ReturnType<ReturnType<DatabaseSync['prepare']>['get']>,sha:string):CertifiedObjectMetadata|null {
 if(!row||row.storage!=='blob'||!Number.isSafeInteger(Number(row.size))||Number(row.size)<0)return null;
 return {scope:'print-object',sha256:sha,size:Number(row.size),storage:String(row.storage),mime:String(row.mime),width:row.width===null?null:Number(row.width),height:row.height===null?null:Number(row.height)};
}
function snapshotObjects(db:DatabaseSync,budget:RecordingPrintSnapshotBudget,certificate?:ObjectAuditCertificateSession):PrintObjectAccessor{
 const maxBytes=budget.maxBytes??128*1024**2,maxEntries=budget.maxEntries??1024;
 if(!db.isTransaction||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>128*1024**2||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>1024)printFail('INVALID_REQUEST');
 const cache=new Map<string,EncodedPrintObject>();let retainedBytes=0;
	 const get=(sha:string,requireRaw=false):EncodedPrintObject=>{
	  const metadata=certifiedMetadata(db.prepare('SELECT length(content) size,typeof(content) storage,mime,width,height FROM recording_print_objects WHERE sha256=?').get(sha),sha);
	  if(!requireRaw&&metadata&&certificate?.matchesObject(metadata))return {bytes:null,size:metadata.size,mime:metadata.mime!,width:metadata.width,height:metadata.height,base64:null};
  // 即使命中仍读取同一事务的实际raw和全部metadata，不以数据库自报SHA代替字节相等。
  const row=db.prepare('SELECT * FROM recording_print_objects WHERE sha256=?').get(sha),prior=cache.get(sha);
  if(prior){
   if(!row||!(row.content instanceof Uint8Array)||!prior.bytes?.equals(row.content)||row.mime!==prior.mime||row.width!==prior.width||row.height!==prior.height)printFail();
   return prior;
  }
  const object=decodePrintObject(row,sha);
  certificate?.observeObject({scope:'print-object',sha256:sha,size:object.size,storage:'blob',mime:object.mime,width:object.width,height:object.height});
  // Buffer、UTF-16编码字符串、key/mime和条目元数据计费；临时SQL row/guard分配不冒称RSS上界。
  const cost=object.size+(object.base64?.length??0)*2+sha.length*2+object.mime.length*2+512;
  if(cache.size<maxEntries&&retainedBytes+cost<=maxBytes){cache.set(sha,object);retainedBytes+=cost;}
  return object;
 };
 return {get,receipt:row=>certificate?.matchesReceipt(`${String(row.kind)}:${String(row.id)}`,receiptCertificateValue(row))??false,observeReceipt(row){certificate?.observeReceipt(`${String(row.kind)}:${String(row.id)}`,receiptCertificateValue(row));},clear(){cache.clear();retainedBytes=0;}};
}
export function printJob(db:DatabaseSync,id:string):dto.RecordingPrintJob{const row=db.prepare('SELECT data FROM recording_print_jobs WHERE id=?').get(id);if(!row)printFail('NOT_FOUND');const job=printParse(row.data,dto.isRecordingPrintJob);if(job.id!==id)printFail();return job;}
export type PrintLeaseIdentity=Pick<dto.RecordingPrintLease,'leaseId'|'workerId'|'jobId'|'requestId'|'inputHash'>;
export interface PrintEvent {job:dto.RecordingPrintJob;lease:PrintLeaseIdentity|null}
const same=(a:unknown,b:unknown)=>mediaFingerprint(a)===mediaFingerprint(b);
function artwork(db:DatabaseSync,snapshot:dto.RecordingArtworkSnapshot,objects:PrintObjectAccessor,masterId?:string):void {
 if(snapshot.state!=='captured')return;
 const v=snapshot.version,row=db.prepare('SELECT data FROM master_artwork_versions WHERE id=?').get(v.id);if(!row||!same(JSON.parse(String(row.data)),v)||masterId&&v.masterVersionId!==masterId)printFail();
 const object=objects.get(v.sha256);if(object.size!==v.size||object.width!==v.width||object.height!==v.height||object.mime!==v.mimeType)printFail();
}
/** 只读闭包校验；不依赖record-store，防止完成登记的循环导入。 */
export function verifyRecordingPrintDatabase(db:DatabaseSync):void {
 verifyPrintDatabase(db,plainObjects(db));
}
/** 仅供Attempt已BEGIN IMMEDIATE、无await/写入的单次审计；返回/异常即销毁，不跨调用复用。 */
export function verifyRecordingPrintSnapshot(db:DatabaseSync,budget:RecordingPrintSnapshotBudget={},certificate?:ObjectAuditCertificateSession):void {
 const objects=snapshotObjects(db,budget,certificate);
 try{verifyPrintDatabase(db,objects);}finally{objects.clear();}
}
function verifyPrintDatabase(db:DatabaseSync,objectAccess:PrintObjectAccessor):void {
 try{
  const schema=db.prepare("SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_print*' OR name GLOB 'master_artwork*'").all();
  if(schema.length!==printSchema.length||schema.some(row=>!printSchema.includes(String(row.sql)))||db.prepare('PRAGMA foreign_key_check').get())printFail();checkPrintBudgets(db);
  const objects=new Set<string>();
  for(const row of db.prepare('SELECT * FROM master_artwork_versions ORDER BY master_id,sequence').iterate()){
   const version=printParse(row.data,dto.isMasterArtworkVersion);if(version.id!==row.id||version.masterVersionId!==row.master_id||version.sequence!==row.sequence||version.sha256!==row.sha256)printFail();
   const master=db.prepare('SELECT data FROM master_versions WHERE id=?').get(version.masterVersionId);if(!master||!dto.isMasterVersion(JSON.parse(String(master.data))))printFail();
   if(version.sequence>1){const previous=db.prepare('SELECT data FROM master_artwork_versions WHERE master_id=? AND sequence=?').get(version.masterVersionId,version.sequence-1);if(!previous||printParse(previous.data,dto.isMasterArtworkVersion).createdAt>version.createdAt)printFail();}
   artwork(db,{state:'captured',version},objectAccess);objects.add(version.sha256);
   const head=db.prepare('SELECT version_id FROM master_artwork_current WHERE master_id=?').get(version.masterVersionId),last=db.prepare('SELECT id FROM master_artwork_versions WHERE master_id=? ORDER BY sequence DESC LIMIT 1').get(version.masterVersionId);if(!head||head.version_id!==last?.id)printFail();
  }
  for(const row of db.prepare('SELECT * FROM master_artwork_current').iterate())if(!db.prepare('SELECT 1 FROM master_artwork_versions WHERE id=? AND master_id=?').get(String(row.version_id),String(row.master_id)))printFail();
  for(const row of db.prepare('SELECT id FROM recording_records').iterate()){
   const {record,plan}=printRecordPlan(db,String(row.id));artwork(db,record.visuals.artwork,objectAccess,plan.master.id);
   if(record.schemaVersion===2&&record.printRequestId!==null){const request=db.prepare('SELECT recording_id FROM recording_print_requests WHERE id=?').get(record.printRequestId);if(request?.recording_id!==record.id)printFail();}
  }
  for(const row of db.prepare('SELECT * FROM recording_print_requests').iterate()){
   const request=printParse(row.data,dto.isRecordingPrintRequest),facts=printParse(row.facts,dto.isRecordingPrintFacts);if(request.id!==row.id||request.recordingId!==row.recording_id)printFail();
   const {record,plan}=printRecordPlan(db,request.recordingId),expected=createRecordingPrintRequest({id:request.id,record,plan,origin:request.origin,createdAt:request.createdAt});
   if(!same(expected,{request,facts})||request.origin==='completion'&&(record.schemaVersion!==2||record.printRequestId!==request.id||request.createdAt!==record.createdAt)||request.origin==='historical-backfill'&&record.schemaVersion!==1)printFail();
   if(!db.prepare('SELECT 1 FROM recording_print_jobs WHERE request_id=?').get(request.id))printFail();
  }
  let active=0;
  for(const row of db.prepare('SELECT * FROM recording_print_jobs').iterate()){
   const current=printParse(row.data,dto.isRecordingPrintJob);if(current.id!==row.id||current.request.id!==row.request_id)printFail();
   const requestRow=db.prepare('SELECT data,facts FROM recording_print_requests WHERE id=?').get(current.request.id);if(!requestRow||!same(current.request,JSON.parse(String(requestRow.data))))printFail();
   let previous:PrintEvent|undefined,previousHash='';
   for(const event of db.prepare('SELECT * FROM recording_print_events WHERE job_id=? ORDER BY revision').iterate(current.id)){
    const data=JSON.parse(String(event.data)) as PrintEvent,job=data.job,lease=data.lease;
    if(Object.keys(data).sort().join(',')!=='job,lease'||!dto.isRecordingPrintJob(job)||job.id!==current.id||!same(job.request,current.request)||job.revision!==(previous?.job.revision??0)+1||job.revision!==event.revision||job.createdAt!==current.createdAt||job.updatedAt<(previous?.job.updatedAt??job.createdAt)||event.previous_hash!==previousHash)printFail();
    if(job.state==='rendering'){
     if(!lease||Object.keys(lease).sort().join(',')!=='inputHash,jobId,leaseId,requestId,workerId'||!dto.isCollectionId(lease.leaseId)||!dto.isCollectionId(lease.workerId)||lease.jobId!==job.id||lease.requestId!==job.request.id||lease.inputHash!==job.request.inputHash)printFail();
    }else if(lease!==null)printFail();
    const valid=!previous?event.kind==='create'&&job.state==='pending' : event.kind==='claim'?previous.job.state==='pending'&&job.state==='rendering':event.kind==='recover'?previous.job.state==='rendering'&&job.state==='pending':event.kind==='retry'?previous.job.state==='failed'&&job.state==='pending':event.kind==='complete'?previous.job.state==='rendering'&&job.state==='ready':event.kind==='fail'&&previous.job.state==='rendering'&&job.state==='failed';
    if(!valid)printFail();const hash=mediaFingerprint({jobId:job.id,revision:job.revision,kind:event.kind,previousHash,data});if(hash!==event.event_hash)printFail();previousHash=hash;previous=data;
   }
   if(!previous||!same(previous,{job:current,lease:row.lease===null?null:JSON.parse(String(row.lease))}))printFail();
   if(current.state==='rendering')++active;
   const artifact=db.prepare('SELECT id FROM recording_print_artifacts WHERE request_id=?').get(current.request.id);if((artifact?.id??null)!==current.artifactId)printFail();
  }
  if(active>1)printFail();
  for(const row of db.prepare('SELECT * FROM recording_print_artifacts').iterate()){
   const artifact=printParse(row.data,dto.isPrintedArtifact);if(artifact.id!==row.id||artifact.requestId!==row.request_id||artifact.pdfSha256!==row.pdf_sha||artifact.previewSha256!==row.preview_sha)printFail();
   const reqRow=db.prepare('SELECT data,facts FROM recording_print_requests WHERE id=?').get(artifact.requestId);if(!reqRow)printFail();const request=printParse(reqRow.data,dto.isRecordingPrintRequest),facts=printParse(reqRow.facts,dto.isRecordingPrintFacts);
   if(artifact.recordingId!==request.recordingId||artifact.inputHash!==request.inputHash||artifact.templateHash!==request.templateHash||artifact.createdAt<request.createdAt||!same(artifact.artwork,facts.artwork))printFail();
   const ready=db.prepare('SELECT data FROM recording_print_jobs WHERE request_id=?').get(artifact.requestId);
   if(!ready||printParse(ready.data,dto.isRecordingPrintJob).updatedAt!==artifact.createdAt)printFail();
   const pdf=objectAccess.get(artifact.pdfSha256),preview=objectAccess.get(artifact.previewSha256);if(pdf.mime!=='application/pdf'||pdf.size!==artifact.size||preview.mime!=='image/jpeg'||preview.size!==artifact.previewSize)printFail();objects.add(artifact.pdfSha256);objects.add(artifact.previewSha256);
  }
  for(const row of db.prepare('SELECT sha256 FROM recording_print_objects').iterate()){if(!objects.has(String(row.sha256)))printFail();objectAccess.get(String(row.sha256));}
  verifyReceipts(db,objectAccess);
  for(const row of db.prepare("SELECT id FROM recording_print_requests WHERE json_extract(data,'$.origin')='historical-backfill'").iterate())if(!db.prepare("SELECT 1 FROM recording_print_receipts WHERE kind='request' AND json_extract(result,'$.request.id')=? AND json_extract(result,'$.revision')=1").get(String(row.id)))printFail();
 }catch(error){if(error instanceof RecordingPrintError)throw error;printFail();}
}
function verifyReceipts(db:DatabaseSync,objects:PrintObjectAccessor):void {
	 for(const row of db.prepare('SELECT * FROM recording_print_receipts').iterate()){
	  const request=JSON.parse(String(row.request)),result=JSON.parse(String(row.result)),certified=objects.receipt(row);let original:unknown=request;
  if(row.kind==='artwork'){
   if(!dto.isMasterArtworkVersion(result))printFail();const version=db.prepare('SELECT data FROM master_artwork_versions WHERE id=?').get(result.id);if(!version||!same(result,JSON.parse(String(version.data))))printFail();
	   const image=objects.get(result.sha256,!certified);if(image.mime!==result.mimeType||image.size!==result.size||image.width!==result.width||image.height!==result.height)printFail();
   // 图像来自本次真实raw校验；只拆字段规则，原完整请求及canonical仍使用实际编码。
	   if(!certified){original={...request,image:objectImage(image)};if(!dto.isSaveMasterArtworkRequestFields(original))printFail();}
	   if(row.id!==`command:${request.commandId}`||request.masterVersionId!==result.masterVersionId)printFail();
   const previous=result.sequence===1?null:db.prepare('SELECT id FROM master_artwork_versions WHERE master_id=? AND sequence=?').get(result.masterVersionId,result.sequence-1)?.id;
	   if(request.expectedVersionId!==previous)printFail();
  }else{
   if(!dto.isRecordingPrintJob(result))printFail();const event=db.prepare('SELECT data FROM recording_print_events WHERE job_id=? AND revision=?').get(result.id,result.revision);if(!event||!same((JSON.parse(String(event.data)) as PrintEvent).job,result))printFail();
   if(row.kind==='complete'){
    const artifact=printParse(db.prepare('SELECT data FROM recording_print_artifacts WHERE id=?').get(result.artifactId!)?.data,dto.isPrintedArtifact);
	    // 新回执必须用真实raw重建原请求fingerprint；对象证书只可替代已认证旧回执的raw读取。
	    const pdf=objects.get(artifact.pdfSha256,!certified),preview=objects.get(artifact.previewSha256,!certified);
	    if(pdf.mime!=='application/pdf'||pdf.size!==artifact.size||preview.mime!=='image/jpeg'||preview.size!==artifact.previewSize)printFail();
	    if(!certified){if(pdf.base64===null)printFail();original={...request,pdfBase64:pdf.base64,preview:objectImage(preview)};if(!dto.isCompleteRecordingPrintRequestFields(original))printFail();}
	    if(result.state!=='ready'||request.pdfSha256!==artifact.pdfSha256||request.pageCount!==artifact.pageCount||request.rendererVersion!==artifact.rendererVersion)printFail();
   }else if(row.kind==='fail'){if(!dto.isFailRecordingPrintRequest(original)||result.state!=='failed'||original.errorCode!==result.errorCode)printFail();}
   else if(row.kind==='retry'){if(!dto.isRetryRecordingPrintRequest(original)||result.state!=='pending'||original.jobId!==result.id||original.expectedRevision!==result.revision-1)printFail();}
   else if(row.kind==='request'){if(!dto.isRequestRecordingPrintRequest(original)||original.recordingId!==result.request.recordingId||original.expectedRecordHash!==result.request.recordingContentHash)printFail();}
   else printFail();
   if(row.kind==='complete'||row.kind==='fail'){
    const req=original as dto.FailRecordingPrintRequest,prior=db.prepare('SELECT data FROM recording_print_events WHERE job_id=? AND revision=?').get(result.id,result.revision-1),lease=prior?(JSON.parse(String(prior.data)) as PrintEvent).lease:null;
    if(!lease||row.id!==`lease:${req.leaseId}`||lease.leaseId!==req.leaseId||lease.workerId!==req.workerId||lease.jobId!==req.jobId||lease.inputHash!==req.inputHash)printFail();
   }else if(row.id!==`command:${(original as dto.RetryRecordingPrintRequest).commandId}`)printFail();
  }
	  if(certified){if(row.kind!=='artwork'&&row.kind!=='complete')printFail();}
	  else {if(mediaFingerprint(original)!==row.fingerprint)printFail();if(row.kind==='artwork'||row.kind==='complete')objects.observeReceipt(row);}
 }
 // 每个显式版本与每次明确状态修改都必须拥有不可变回执；恢复和自动创建不需要伪命令。
 for(const row of db.prepare('SELECT id FROM master_artwork_versions').iterate())if(!db.prepare("SELECT 1 FROM recording_print_receipts WHERE kind='artwork' AND json_extract(result,'$.id')=?").get(String(row.id)))printFail();
 for(const event of db.prepare("SELECT job_id,revision,kind FROM recording_print_events WHERE kind IN ('retry','complete','fail')").iterate())if(!db.prepare("SELECT 1 FROM recording_print_receipts WHERE kind=? AND json_extract(result,'$.id')=? AND json_extract(result,'$.revision')=?").get(String(event.kind),String(event.job_id),Number(event.revision)))printFail();
}
