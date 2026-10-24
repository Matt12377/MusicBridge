import {StringDecoder} from 'node:string_decoder';
import {copyCatalogPrivateRecord,CATALOG_PRIVATE_PREFIX} from './catalog-private-record-guard.mjs';
export {copyCatalogPrivateRecord,CATALOG_PRIVATE_PREFIX};
const int=(x,a,b)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=a&&x<=b;
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
