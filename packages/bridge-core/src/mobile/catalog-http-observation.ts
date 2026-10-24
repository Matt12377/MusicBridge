import { emitCatalogTraceMarker, copyCatalogTraceSeed, type CatalogTraceSeed } from './catalog-private-trace.js';
const active = new Map<string,{nonces:Set<string>;dropped:number;sink:(line:string)=>void}>();
/** 只存当前显式armed的HTTP；HTTP结束删除，不累计页号或成功历史。 */
export function registerCatalogHttpNonce(seed: CatalogTraceSeed): void {
  try {
    if(!copyCatalogTraceSeed(seed))return;
    const state=active.get(seed.requestSha256);if(state){if(state.nonces.size<32)state.nonces.add(seed.nonceSha256);else state.dropped++;}
    emitCatalogTraceMarker({...seed,schema:'mb.catalog-marker.v1',component:'main',kind:'nonce-register',epochMs:Date.now(),status:null,
      failed:false,finished:false,count:0,forwarded:0,dropped:0},state?.sink);
  }catch{/* 不改变原RPC。 */}
}
export function dropCatalogHttpNonce(requestSha256:string): void {
  const state=active.get(requestSha256);if(state)state.dropped=Math.min(Number.MAX_SAFE_INTEGER,state.dropped+1);
}
export function createCatalogHttpObservation(enabled: boolean, sink:(line:string)=>void=line=>{process.stdout.write(line);}) {
  // 失败仅结束本次scope；连续旁注仍受本实例4096次准入及原活动槽/下游预算约束。
  let admitted=0;
  return { begin(requestSha256:string) {
    if(!enabled||admitted>=4096||active.size>=16||active.has(requestSha256)||!/^[a-f0-9]{64}$/u.test(requestSha256))return undefined;
    admitted++;
    const state={nonces:new Set<string>(),dropped:0,sink};active.set(requestSha256,state);
    emitCatalogTraceMarker({schema:'mb.catalog-marker.v1',requestSha256,nonceSha256:null,offset:null,limit:null,component:'main',kind:'http-begin',
      epochMs:Date.now(),status:null,failed:false,finished:false,count:0,forwarded:0,dropped:0},sink);
    let ended=false;
    return {finish(status:number|null,failed:boolean,finished:boolean){
      if(ended)return;ended=true;active.delete(requestSha256);const failure=failed||!finished||status===null||status>=400;
      emitCatalogTraceMarker({schema:'mb.catalog-marker.v1',requestSha256,nonceSha256:null,offset:null,limit:null,component:'main',kind:'http-terminal',
        epochMs:Date.now(),status,failed:failure,finished,count:state.nonces.size,forwarded:0,dropped:state.dropped},sink);
    }};
  }};
}
