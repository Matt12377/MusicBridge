import { StringDecoder } from 'node:string_decoder';
import { types } from 'node:util';
export const CATALOG_PRIVATE_PREFIX = 'MUSICBRIDGE_MOBILE_CATALOG_TRACE ';
const stages = ['main.request','main.owner-await','main.result','core.receive','core.owner-await','core.result','owner.receive','owner.refresh',
  'owner.revision','owner.sql-page','owner.catalog.prepare-fallback','owner.item.detail','owner.item.file-parameters','owner.item.title','owner.item.segment',
  'owner.item.duration','owner.item.audio-map','owner.item.availability','owner.item.close-proof','owner.item.dto','owner.page-seal',
  'owner.result-boundary','owner.reply',
  'owner.sql.audit','owner.sql.audit-catalog','owner.sql.audit-scan','owner.sql.admission','owner.sql.worker','owner.sql.rollback',
  'owner.sql.connection-close','owner.sql.worker-exit','owner.inventory-reenter','owner.structure-seal',
  "owner.item.file-parameters.null.binding","owner.item.file-parameters.null.state-missing","owner.item.file-parameters.null.state-binding","owner.item.file-parameters.null.job-binding","owner.item.file-parameters.null.read-facts","owner.item.file-parameters.null.source-dto","owner.item.file-parameters.null.batch-missing","owner.item.file-parameters.null.batch-item","owner.item.file-parameters.null.batch-signature","owner.item.file-parameters.null.batch-read-facts","owner.item.file-parameters.null.origin-none","owner.item.file-parameters.null.origin-job-binding","owner.item.file-parameters.null.origin-item","owner.item.file-parameters.null.origin-ledger-count","owner.item.file-parameters.null.origin-ledger-asset","owner.item.file-parameters.null.parameters","owner.item.file-parameters.throw.input","owner.item.file-parameters.throw.binding","owner.item.file-parameters.throw.scan-state","owner.item.file-parameters.throw.scan-job","owner.item.file-parameters.throw.source-proof","owner.item.file-parameters.throw.batch","owner.item.file-parameters.throw.origin","owner.item.file-parameters.throw.parameters"];
const metricStages=["owner.item.detail.calls", "owner.item.detail.total-ms", "owner.item.file-parameters.calls", "owner.item.file-parameters.total-ms", "owner.item.title.calls", "owner.item.title.total-ms", "owner.item.segment.calls", "owner.item.segment.total-ms", "owner.item.duration.calls", "owner.item.duration.total-ms", "owner.item.audio-map.calls", "owner.item.audio-map.total-ms", "owner.item.availability.calls", "owner.item.availability.total-ms", "owner.item.dto.calls", "owner.item.dto.total-ms", "owner.item.artwork.calls", "owner.item.artwork.total-ms", "owner.item.dto-validation.calls", "owner.item.dto-validation.total-ms"];
stages.push("owner.item.artwork","owner.item.dto-validation",...metricStages);
const codes = ['OK','UNKNOWN','BUSY','SOURCE_CHANGED','CONTENT_LIMIT_EXCEEDED','INVALID_REQUEST','INVALID_RESPONSE',
  'RESOURCE_REVOKED','INVENTORY_UNAVAILABLE','UNAVAILABLE','SNAPSHOT_CHANGED','TIMEOUT','NOT_READY'];
const keys=['schema','requestSha256','nonceSha256','offset','limit','component','sequence','epochMs','elapsedMs','rowOrdinal','stage','phase','role','code','matched','count'];
const int=(x,a,b)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=a&&x<=b;
export function copyCatalogPrivateRecord(raw) {
  try {
    if(!raw||typeof raw!=='object'||types.isProxy(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))return null;
    const d=Object.getOwnPropertyDescriptors(raw);
    if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable===true&&Object.hasOwn(d[k],'value')))return null;
    const v=Object.fromEntries(keys.map(k=>[k,d[k].value]));
    if(v.schema!==1||typeof v.requestSha256!=='string'||!/^[a-f0-9]{64}$/u.test(v.requestSha256)
      ||typeof v.nonceSha256!=='string'||!/^[a-f0-9]{64}$/u.test(v.nonceSha256)||!int(v.offset,0,300000)||!int(v.limit,1,100)
      ||!['main','core','owner'].includes(v.component)||!int(v.sequence,1,64)||!int(v.epochMs,0,Number.MAX_SAFE_INTEGER)
      ||typeof v.elapsedMs!=='number'||!Number.isFinite(v.elapsedMs)||v.elapsedMs<0||v.rowOrdinal!==null&&!int(v.rowOrdinal,1,100)
      ||!stages.includes(v.stage)||!v.stage.startsWith(v.component+'.')||!['begin','ok','reject'].includes(v.phase)
      ||!['business','cleanup'].includes(v.role)||!codes.includes(v.code)||v.phase!=='reject'&&v.code!=='OK'
      ||v.matched!==null&&typeof v.matched!=='boolean'||v.count!==null&&!int(v.count,0,300000))return null;
    if(metricStages.includes(v.stage)&&(v.rowOrdinal!==null||v.count===null||typeof v.matched!=='boolean'||v.phase!=='ok'||v.role!=='business'))return null;
    if(v.stage==='owner.catalog.prepare-fallback'&&(v.component!=='owner'||v.phase!=='ok'||v.role!=='business'||v.rowOrdinal!==null||v.count!==1||v.matched!==false))return null;
    return Object.freeze(v);
  }catch{return null;}
}
/** 只保闭集record；两路增量UTF8解码，未知行丢弃，不写原stdout/stderr。 */
export function createCatalogPrivateReader({onRecord,maxRecords=2048,maxBytes=2*1024*1024}) {
  if(typeof onRecord!=='function'||!int(maxRecords,0,2048)||!int(maxBytes,0,2*1024*1024))throw new Error('目录诊断读取预算无效。');
  const nonces=new Map();let streams=0,accepted=0,bytes=0,invalid=0,oversized=0,suppressed=0,unregistered=0,deduplicated=0,sinkFailures=0;
  function line(text) {
    if(!text.startsWith(CATALOG_PRIVATE_PREFIX))return;
    if(Buffer.byteLength(text+'\n')>2048){oversized++;return;}
    let row;try{row=copyCatalogPrivateRecord(JSON.parse(text.slice(CATALOG_PRIVATE_PREFIX.length)));}catch{}
    if(!row){invalid++;return;}
    let state=nonces.get(row.nonceSha256);
    if(!state&&row.component==='main'&&row.stage==='main.request'&&row.phase==='begin'&&row.sequence===1) {
      if(nonces.size>=32){suppressed++;return;}
      state={request:row.requestSha256,offset:row.offset,limit:row.limit,records:0,bytes:0,normal:0,failures:new Set(),seen:new Set()};nonces.set(row.nonceSha256,state);
    }
    if(!state||row.requestSha256!==state.request||row.offset!==state.offset||row.limit!==state.limit){unregistered++;return;}
    const id=row.component+':'+row.sequence,key=row.component+':'+row.role,first=row.phase==='reject'&&!state.failures.has(key);
    if(state.seen.has(id)){deduplicated++;return;}
    const encoded=JSON.stringify(row)+'\n',size=Buffer.byteLength(encoded);
    if(accepted>=maxRecords||bytes+size>maxBytes||state.records>=64||state.bytes+size>65536||!first&&(row.phase==='reject'||state.normal>=58)){suppressed++;return;}
    state.seen.add(id);state.records++;state.bytes+=size;if(first)state.failures.add(key);else state.normal++;
    accepted++;bytes+=size;try{onRecord(row);}catch{sinkFailures++;}
  }
  return {
    createStream() {
      if(streams>=2)throw new Error('目录诊断仅允许两条原输出流。');streams++;
      const decoder=new StringDecoder('utf8');let pending='',discard=false,ended=false;
      const text=value=>{
        for(const part of value.split(/(?<=\n)/u)) {
          if(!discard)pending+=part;
          if(Buffer.byteLength(pending)>2048){pending='';discard=true;oversized++;}
          if(!part.endsWith('\n'))continue;
          if(!discard)line(pending.slice(0,-1));pending='';discard=false;
        }
      };
      return {write(chunk){if(ended)return;try{if(Buffer.byteLength(chunk)>1024*1024){pending='';discard=true;oversized++;return;}text(typeof chunk==='string'?chunk:decoder.write(chunk));}catch{invalid++;}},
        end(){if(ended)return;ended=true;try{text(decoder.end());}catch{invalid++;}pending='';}};
    },
    snapshot(){return {schema:'mb.catalog-private-reader.v1',acceptedRecords:accepted,acceptedBytes:bytes,invalidRecords:invalid,
      oversizedLines:oversized,suppressedRecords:suppressed,unregisteredRecords:unregistered,deduplicatedRecords:deduplicated,
      sinkFailures,nonceCount:nonces.size,streamCount:streams,rawStdoutPersisted:false,rawStderrPersisted:false,
      limits:{records:maxRecords,bytes:maxBytes,perNonceRecords:64,perNonceBytes:65536,normalPerNonce:58,nonces:32}};},
  };
}
