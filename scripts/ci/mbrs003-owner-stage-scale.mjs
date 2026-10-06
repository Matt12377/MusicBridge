// 仅核Root冻结的可移植历史JSON；Owner阶段接受不等于当前规模或技术PASS。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const STATUS='OWNER_ACCEPTED_HISTORICAL_SCALE_WITH_CARRYOVER';
const MAX_BYTES=256*1024;
const COUNTS={visited:300000,accepted:299975,rejected:25,timeout:20,workerStartTimeout:5};
const ROLES=['result','gate','diagnostic','diagnosticClosure'];
const READER_CODES=['REVOKED','SOURCE_ROOT_OFFLINE','OUTSIDE_ROOT','MISSING','CONTENT_CHANGED','IO_ERROR','BUDGET_EXCEEDED','PARSE_FAILED','UNSUPPORTED','TIMEOUT','WORKER_START_TIMEOUT','CANCELLED','CLOSED','QUEUE_FULL','WORKER_FAILED','LEASE_RELEASE_FAILED','ADMISSION_FAILED'];
const CATALOG_CODES=['CATALOG_METADATA_INVALID','CATALOG_FIELD_INVALID_TITLE','CATALOG_FIELD_INVALID_ARTIST','CATALOG_FIELD_INVALID_ALBUM','CATALOG_FIELD_INVALID_YEAR','CATALOG_FIELD_INVALID_DISC','CATALOG_FIELD_INVALID_TRACK'];
export const OWNER_STAGE_SCALE_FAILURES=Object.freeze(['OWNER_STAGE_SCALE_NOT_ADMITTED','OWNER_STAGE_SCALE_REFERENCE_INVALID','OWNER_STAGE_SCALE_PATH_INVALID','OWNER_STAGE_SCALE_FILE_INVALID','OWNER_STAGE_SCALE_FILE_CHANGED','OWNER_STAGE_SCALE_JSON_INVALID','OWNER_STAGE_SCALE_HISTORY_INVALID','OWNER_STAGE_SCALE_BUDGET_EXPIRED']);
const CODES=new Set(OWNER_STAGE_SCALE_FAILURES);
function fail(code){const error=new Error(code);error.code=code;throw error}
function need(ok,code){if(!ok)fail(code)}
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,names)=>plain(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify([...names].sort());
const refEqual=(a,b)=>plain(a)&&plain(b)&&a.path===b.path&&a.bytes===b.bytes&&a.sha256===b.sha256;
const object=s=>['dev','ino','mode','nlink','uid','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
function check(budget){try{budget.check('OWNER_ACCEPTED_HISTORICAL_SCALE')}catch{fail('OWNER_STAGE_SCALE_BUDGET_EXPIRED')}}
function reference(ref,original=false){
 need(keys(ref,['path','bytes','sha256'])&&typeof ref.path==='string'&&ref.path.length>0&&ref.path.length<4096&&!/[\u0000-\u001f\\]/u.test(ref.path)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=MAX_BYTES&&typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/u.test(ref.sha256),'OWNER_STAGE_SCALE_REFERENCE_INVALID');
 if(!original)need(!path.isAbsolute(ref.path)&&ref.path.split('/').every(x=>x!==''&&x!=='.'&&x!=='..'),'OWNER_STAGE_SCALE_PATH_INVALID');
 // originalRef仅作为不可移植历史来源标识比较，绝不打开。
}
function localPath(root,relative,budget){
 check(budget);const segments=relative.split('/');let p=root;
 for(let i=0;i<segments.length;i++){
  check(budget);p=path.join(p,segments[i]);const st=fs.lstatSync(p,{bigint:true});check(budget);
  need(!st.isSymbolicLink()&&(i===segments.length-1?st.isFile():st.isDirectory()),'OWNER_STAGE_SCALE_PATH_INVALID');
 }
 need(path.relative(root,p)===relative&&fs.realpathSync(p)===p,'OWNER_STAGE_SCALE_PATH_INVALID');check(budget);return p;
}
function readPinned(ref,root,budget){
 reference(ref);const p=localPath(root,ref.path,budget);check(budget);const before=fs.lstatSync(p,{bigint:true});
 need(before.isFile()&&!before.isSymbolicLink()&&before.size===BigInt(ref.bytes),'OWNER_STAGE_SCALE_FILE_INVALID');
 check(budget);const fd=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let bytes;
 try{
  check(budget);need(object(fs.fstatSync(fd,{bigint:true}))===object(before),'OWNER_STAGE_SCALE_FILE_CHANGED');
  bytes=Buffer.alloc(ref.bytes);let offset=0;
  while(offset<bytes.length){check(budget);const n=fs.readSync(fd,bytes,offset,Math.min(65536,bytes.length-offset),offset);check(budget);need(n>0,'OWNER_STAGE_SCALE_FILE_CHANGED');offset+=n}
  need(object(fs.fstatSync(fd,{bigint:true}))===object(before),'OWNER_STAGE_SCALE_FILE_CHANGED');check(budget);
 }finally{fs.closeSync(fd)}
 check(budget);need(object(fs.lstatSync(p,{bigint:true}))===object(before),'OWNER_STAGE_SCALE_FILE_CHANGED');
 need(createHash('sha256').update(bytes).digest('hex')===ref.sha256,'OWNER_STAGE_SCALE_FILE_CHANGED');check(budget);let value;
 try{value=JSON.parse(bytes.toString('utf8'))}catch{fail('OWNER_STAGE_SCALE_JSON_INVALID')}
 need(plain(value),'OWNER_STAGE_SCALE_JSON_INVALID');check(budget);return value;
}

export async function readOwnerAcceptedHistoricalScale(spec,root,budget){
 try{
  need(budget&&typeof budget.check==='function','OWNER_STAGE_SCALE_NOT_ADMITTED');check(budget);
  need(plain(spec)&&spec.mode===STATUS&&spec.fullScalePass!==true&&spec.currentFullScalePass===false&&spec.finalRealLibraryAcceptance==='DEFERRED_UNTIL_COMPLETE_PRODUCT','OWNER_STAGE_SCALE_NOT_ADMITTED');
  reference(spec.decisionRef);need(typeof root==='string'&&path.isAbsolute(root),'OWNER_STAGE_SCALE_PATH_INVALID');
  const canonicalRoot=path.resolve(root);need(fs.realpathSync(canonicalRoot)===canonicalRoot&&fs.lstatSync(canonicalRoot).isDirectory()&&!fs.lstatSync(canonicalRoot).isSymbolicLink(),'OWNER_STAGE_SCALE_PATH_INVALID');check(budget);
  const decision=readPinned(spec.decisionRef,canonicalRoot,budget);
  need(decision.schema==='mbrs003.owner-stage-scale-acceptance.v1'&&decision.status===STATUS&&decision.accepted===true&&decision.rerunCurrent100k300k===false&&decision.currentFullScalePass===false&&decision.currentFullScaleObserved===false&&decision.newScaleRunStarted===false&&decision.newScaleRoundAuthorized===false&&decision.authority==='OWNER_DIRECT_MESSAGE_IN_CURRENT_CHAT'&&decision.physicalCause==='UNKNOWN'&&decision.historicalTechnicalStatus==='FAILURE_PRESERVED'&&decision.historicalStagesFourAndFive==='NOT_RUN_PRESERVED'&&decision.fullScalePass!==true&&decision.finalRealLibraryAcceptance==='DEFERRED_UNTIL_COMPLETE_PRODUCT','OWNER_STAGE_SCALE_NOT_ADMITTED');
  need(keys(decision.historicalCounts,Object.keys(COUNTS))&&Object.entries(COUNTS).every(([k,v])=>decision.historicalCounts[k]===v),'OWNER_STAGE_SCALE_HISTORY_INVALID');
  need(keys(decision.historicalEvidence,ROLES),'OWNER_STAGE_SCALE_REFERENCE_INVALID');const references=new Set([spec.decisionRef.path]),values={};
  for(const role of ROLES){
   check(budget);const ref=decision.historicalEvidence[role];need(keys(ref,['path','bytes','sha256','originalRef']),'OWNER_STAGE_SCALE_REFERENCE_INVALID');
   const local={path:ref.path,bytes:ref.bytes,sha256:ref.sha256};reference(local);reference(ref.originalRef,true);
   need(ref.path!==ref.originalRef.path&&ref.bytes===ref.originalRef.bytes&&ref.sha256===ref.originalRef.sha256&&!references.has(ref.path),'OWNER_STAGE_SCALE_REFERENCE_INVALID');
   references.add(ref.path);values[role]=readPinned(local,canonicalRoot,budget);
  }
  const {result,gate,diagnostic,diagnosticClosure:closure}=values,stage=result.metrics?.stages?.[2];
  need(result.schema==='mbrs003.digital-audio-scale-observation.v3'&&result.status==='FAILURE'&&result.count===300000&&result.timedOut===false&&result.metrics?.readerCalls===300000&&result.metrics?.ok===299975&&result.metrics?.failures===25&&stage?.name==='new-job-after-cancel-completes-first-corpus'&&stage.phase==='completed'&&stage.progress?.visited==='300000'&&stage.progress?.accepted==='299975'&&stage.progress?.rejected==='25','OWNER_STAGE_SCALE_HISTORY_INVALID');
  need(gate.exitCode===1&&gate.timedOut===false&&gate.signal===null,'OWNER_STAGE_SCALE_HISTORY_INVALID');
  need(diagnostic.committedFileCount===300000&&diagnostic.accepted===299975&&diagnostic.rejected===25&&diagnostic.committedBatchCount===1501&&diagnostic.unknownCodeCount===0,'OWNER_STAGE_SCALE_HISTORY_INVALID');
  need(keys(diagnostic.readerFailureCodeCounts,READER_CODES)&&READER_CODES.every(k=>diagnostic.readerFailureCodeCounts[k]===(k==='TIMEOUT'?20:k==='WORKER_START_TIMEOUT'?5:0))&&keys(diagnostic.catalogFailureCodeCounts,CATALOG_CODES)&&CATALOG_CODES.every(k=>diagnostic.catalogFailureCodeCounts[k]===0),'OWNER_STAGE_SCALE_HISTORY_INVALID');
  const coverage=diagnostic.coverageAndConsistency;
  need(coverage?.metadataCoverageComplete===true&&coverage.countsMatchExpected===true&&coverage.checkpointChainVerified===true&&coverage.batchItemPairingVerified===true&&coverage.physicalCause==='UNKNOWN'&&coverage.scalePass===false&&coverage.whole003Pass===false,'OWNER_STAGE_SCALE_HISTORY_INVALID');
  need(closure.schema==='mbrs003.root.actual-tool-execution-closure.v1'&&closure.status==='ROOT_ACTUAL_TOOL_RETURN_WAIT_STDIO_CLOSED'&&closure.component==='CLOSED_NEW06_COMMITTED_FAILURE_CODES_PRODUCER04'&&closure.actualWrapperExitCode===0&&closure.actualWrapperWaitCompleted===true&&closure.actualWrapperStdiosClosed===true&&closure.actualChildWaitCompleted===true&&closure.actualArchiveWaitCompleted===true&&closure.archiveExitCode===0&&refEqual(closure.diagnosticRef,decision.historicalEvidence.diagnostic.originalRef),'OWNER_STAGE_SCALE_HISTORY_INVALID');
  need(closure.classifiedRejectedCount===25&&keys(closure.safeKnownCodeCounts,['TIMEOUT','WORKER_START_TIMEOUT'])&&closure.safeKnownCodeCounts.TIMEOUT===20&&closure.safeKnownCodeCounts.WORKER_START_TIMEOUT===5&&closure.unknownCodeCount===0&&closure.physicalCause==='UNKNOWN'&&closure.itemIdentifiers==='UNKNOWN_NOT_EXPORTED'&&closure.originalDatabaseSQLiteOpened===false&&closure.newScanStarted===false&&closure.ReaderStarted===false&&closure.WorkerStarted===false&&closure.scalePass===false&&closure.whole003Pass===false,'OWNER_STAGE_SCALE_HISTORY_INVALID');
  // 最终逐件再次核固定字节；只返回摘要，不把原库路径/原argv当作当前执行。
  readPinned(spec.decisionRef,canonicalRoot,budget);
  for(const role of ROLES){const ref=decision.historicalEvidence[role];readPinned({path:ref.path,bytes:ref.bytes,sha256:ref.sha256},canonicalRoot,budget)}
  check(budget);return {status:STATUS,fullScalePass:false,currentFullScaleObserved:false,noScaleExecutionInGate:true,ownerAcceptedHistoricalScale:true,finalRealLibraryAcceptance:'DEFERRED_UNTIL_COMPLETE_PRODUCT',physicalCause:'UNKNOWN',itemIdentifiers:'UNKNOWN_NOT_EXPORTED',historicalCounts:{...COUNTS},decisionRef:{...spec.decisionRef},historicalEvidence:decision.historicalEvidence};
 }catch(error){if(CODES.has(error?.code))throw error;fail('OWNER_STAGE_SCALE_FILE_INVALID')}
}
