import { StringDecoder } from 'node:string_decoder';
import { types } from 'node:util';
import { copyCatalogPrivateRecord, CATALOG_PRIVATE_PREFIX } from './catalog-private-record-guard.mjs';
export {copyCatalogPrivateRecord,CATALOG_PRIVATE_PREFIX};
export const CATALOG_MARKER_PREFIX='MUSICBRIDGE_MOBILE_CATALOG_MARKER ';
const int=(x,a,b)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=a&&x<=b;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const keys=['schema','requestSha256','nonceSha256','offset','limit','component','kind','epochMs','status','failed','finished','count','forwarded','dropped'];
export function copyCatalogPrivateMarker(raw){
 try{
  if(!raw||typeof raw!=='object'||types.isProxy(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))return null;
  const d=Object.getOwnPropertyDescriptors(raw);if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))return null;
  const v=Object.fromEntries(keys.map(k=>[k,d[k].value]));
  if(v.schema!=='mb.catalog-marker.v1'||!sha(v.requestSha256)||!['main','core','owner'].includes(v.component)
   ||!['http-begin','nonce-register','scope-close','http-terminal'].includes(v.kind)||!int(v.epochMs,0,Number.MAX_SAFE_INTEGER)
   ||v.status!==null&&!int(v.status,100,599)||typeof v.failed!=='boolean'||typeof v.finished!=='boolean'
   ||!int(v.count,0,64)||!int(v.forwarded,0,64)||v.forwarded>v.count||!int(v.dropped,0,Number.MAX_SAFE_INTEGER))return null;
  const scope=v.kind==='nonce-register'||v.kind==='scope-close';
  if(scope?!sha(v.nonceSha256)||!int(v.offset,0,300000)||!int(v.limit,1,100):v.nonceSha256!==null||v.offset!==null||v.limit!==null||v.component!=='main')return null;
  if(v.kind!=='scope-close'&&v.component!=='main'||v.kind!=='http-terminal'&&(v.status!==null||v.failed||v.finished))return null;
  return Object.freeze(v);
 }catch{return null;}
}
/** 任意后页仅活动侧车；stdout/stderr显式close/count合并，不按时间猜完成。 */
export function createCatalogPrivateReader({onRecord,maxRecords=100000,maxBytes=32*1024*1024}){
 if(typeof onRecord!=='function'||!int(maxRecords,0,100000)||!int(maxBytes,0,32*1024*1024))throw new Error('目录诊断读取预算无效。');
 const http=new Map(),nonces=new Map(),retired=new Set();let successPublished=0,failurePublished=0;
 let streams=0,ends=0,accepted=0,bytes=0,buffered=0,bufferedBytes=0,invalid=0,oversized=0,suppressed=0,unregistered=0,dedup=0,sinkFailures=0,peakHttp=0,peakNonce=0;
 function tombstone(id){retired.add(id);if(retired.size>32)retired.delete(retired.values().next().value);}
 function erase(id){http.delete(id);for(const [nonce,s] of nonces)if(s.seed.requestSha256===id){buffered-=s.rows.length;bufferedBytes-=s.bytes;nonces.delete(nonce);}tombstone(id);}
 function getHttp(id){
  if(retired.has(id))return null;
  let s=http.get(id);if(s)return s;
  if(http.size>=16){suppressed++;return null;}
  s={begin:null,terminal:null,truncated:false};http.set(id,s);peakHttp=Math.max(peakHttp,http.size);return s;
 }
 function getNonce(row){
  if(retired.has(row.requestSha256))return null;
  let s=nonces.get(row.nonceSha256);
  if(s){if(s.seed.requestSha256!==row.requestSha256||s.seed.offset!==row.offset||s.seed.limit!==row.limit){unregistered++;return null;}return s;}
  if(nonces.size>=32){suppressed++;const h=http.get(row.requestSha256);if(h)h.truncated=true;return null;}
  s={seed:{requestSha256:row.requestSha256,nonceSha256:row.nonceSha256,offset:row.offset,limit:row.limit},registered:false,
   rows:[],bytes:0,normal:0,seen:new Set(),received:{main:0,core:0,owner:0},closes:{},failures:new Set(),truncated:false};
  nonces.set(row.nonceSha256,s);peakNonce=Math.max(peakNonce,nonces.size);return s;
 }
 function send(row){const size=Buffer.byteLength(JSON.stringify(row)+'\n');if(accepted>=maxRecords||bytes+size>maxBytes){suppressed++;return false;}
  accepted++;bytes+=size;try{onRecord(row);return true;}catch{sinkFailures++;return false;}}
 function publish(id,force=false){
  const h=http.get(id);if(!h?.terminal)return;
  const scopes=[...nonces.values()].filter(s=>s.seed.requestSha256===id);
  const registered=scopes.filter(s=>s.registered);
  const allClosed=!!h.begin&&registered.length===h.terminal.count&&registered.every(s=>['main','core','owner'].every(c=>s.closes[c]&&s.received[c]===s.closes[c].forwarded&&(s.closes[c].forwarded<s.closes[c].count||Array.from({length:s.closes[c].count},(_,i)=>i+1).every(n=>s.seen.has(c+':'+n)))));
  if(!allClosed&&!force)return;
  const truncated=h.truncated||h.terminal.dropped>0||registered.some(s=>s.truncated||Object.values(s.closes).some(c=>c.dropped>0||c.forwarded<c.count));
  const selected=h.terminal.failed||!h.terminal.finished||h.terminal.status===null||h.terminal.status>=400?'failure':'success';
  // 连续输出明确闭合的请求；活动状态与总输出仍受独立硬上限约束。
  const summary={schema:'mb.catalog-http-sample.v1',selection:selected,requestSha256:id,beginEpochMs:h.begin?.epochMs??null,
   terminalEpochMs:h.terminal.epochMs,status:h.terminal.status,failed:h.terminal.failed,finished:h.terminal.finished,
   complete:allClosed&&!truncated,truncated,nonceCount:registered.length,expectedNonceCount:h.terminal.count,
   incompleteReason:!allClosed?'missing-close-or-records':truncated?'capacity-or-producer-drop':null,
   scopes:registered.map(s=>({...s.seed,records:s.rows.length,closes:['main','core','owner'].map(c=>({component:c,expected:s.closes[c]?.count??null,
    received:s.received[c],forwarded:s.closes[c]?.forwarded??null,dropped:s.closes[c]?.dropped??null}))}))};
  const rows=registered.flatMap(s=>s.rows),bundle=[...rows,summary];
  const bundleBytes=bundle.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row)+'\n'),0);
  // 容量按整页预检，绝不先发完整摘要、再因硬上限丢掉尾部记录。
  if(accepted+bundle.length>maxRecords||bytes+bundleBytes>maxBytes){suppressed+=bundle.length;erase(id);return;}
  let delivered=true;for(const row of rows)if(!send(row))delivered=false;
  // 摘要最后交付；任何sink失败都不能留下完整收口声明。
  if(delivered&&send(summary)){if(selected==='failure')failurePublished++;else successPublished++;}

  erase(id);
 }
 function check(id){publish(id);}
 function marker(row){
  const id=row.requestSha256;
  if(row.kind==='http-begin'){const h=getHttp(id);if(!h)return;if(h.begin){dedup++;return;}h.begin=row;check(id);return;}
  if(row.kind==='http-terminal'){
   if(retired.has(id))return;
   const failed=row.failed||!row.finished||row.status===null||row.status>=400;
   const h=getHttp(id);if(!h)return;if(h.terminal){dedup++;return;}h.terminal=row;
   check(id);return;
  }
  const s=getNonce(row);if(!s)return;
  if(row.kind==='nonce-register'){if(s.registered){dedup++;return;}s.registered=true;}
  else {if(s.closes[row.component]){dedup++;return;}s.closes[row.component]=row;}
  check(id);
 }
 function record(row){
  const s=getNonce(row);if(!s)return;const id=row.component+':'+row.sequence;
  if(s.seen.has(id)){dedup++;return;}s.seen.add(id);s.received[row.component]++;
  const key=row.component+':'+row.role,first=row.phase==='reject'&&!s.failures.has(key),size=Buffer.byteLength(JSON.stringify(row)+'\n');
  if(buffered>=2048||bufferedBytes+size>2*1024*1024||s.rows.length>=64||s.bytes+size>65536||!first&&(row.phase==='reject'||s.normal>=58)){
   s.truncated=true;suppressed++;check(row.requestSha256);return;
  }
  if(first)s.failures.add(key);else s.normal++;
  s.rows.push(row);s.bytes+=size;buffered++;bufferedBytes+=size;check(row.requestSha256);
 }
 function line(text){
  const isRow=text.startsWith(CATALOG_PRIVATE_PREFIX),isMark=text.startsWith(CATALOG_MARKER_PREFIX);if(!isRow&&!isMark)return;
  if(Buffer.byteLength(text+'\n')>2048){oversized++;return;}
  let value;try{value=JSON.parse(text.slice((isRow?CATALOG_PRIVATE_PREFIX:CATALOG_MARKER_PREFIX).length));}catch{invalid++;return;}
  const copied=isRow?copyCatalogPrivateRecord(value):copyCatalogPrivateMarker(value);if(!copied){invalid++;return;}
  if(isRow)record(copied);else marker(copied);
 }
 return {createStream(){
  if(streams>=2)throw new Error('目录诊断仅允许两条原输出流。');streams++;
  const decoder=new StringDecoder('utf8');let pending='',discard=false,ended=false;
  const text=value=>{for(const part of value.split(/(?<=\n)/u)){if(!discard)pending+=part;if(Buffer.byteLength(pending)>2048){pending='';discard=true;oversized++;}
   if(!part.endsWith('\n'))continue;if(!discard)line(pending.slice(0,-1));pending='';discard=false;}};
  return {write(chunk){if(ended)return;try{if(Buffer.byteLength(chunk)>1024*1024){pending='';discard=true;oversized++;return;}text(typeof chunk==='string'?chunk:decoder.write(chunk));}catch{invalid++;}},
   end(){if(ended)return;ended=true;try{text(decoder.end());}catch{invalid++;}pending='';ends++;if(ends===streams){for(const id of [...http.keys()])publish(id,true);for(const id of [...http.keys()])erase(id);nonces.clear();buffered=0;bufferedBytes=0;}}};
 },snapshot(){return {schema:'mb.catalog-private-reader.v3',acceptedRecords:accepted,acceptedBytes:bytes,invalidRecords:invalid,oversizedLines:oversized,
  suppressedRecords:suppressed,unregisteredRecords:unregistered,deduplicatedRecords:dedup,sinkFailures,nonceCount:nonces.size,httpCount:http.size,
  bufferedRecords:buffered,bufferedBytes,peakHttpCount:peakHttp,peakNonceCount:peakNonce,streamCount:streams,failureRequestsPublished:failurePublished,
  successRequestsPublished:successPublished,rawStdoutPersisted:false,rawStderrPersisted:false,
  limits:{records:maxRecords,bytes:maxBytes,activeHttp:16,nonces:32,perNonceRecords:64,perNonceBytes:65536,normalPerNonce:58}};}};
}
