import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { createHash } from 'node:crypto';

export const MOBILE_CATALOG_TRACE_PREFIX = 'MUSICBRIDGE_MOBILE_CATALOG_TRACE ';
export const CATALOG_FILE_PARAMETERS_BRANCH_STAGES = [
  'owner.item.file-parameters.null.binding', 'owner.item.file-parameters.null.state-missing',
  'owner.item.file-parameters.null.state-binding', 'owner.item.file-parameters.null.job-binding',
  'owner.item.file-parameters.null.read-facts', 'owner.item.file-parameters.null.source-dto',
  'owner.item.file-parameters.null.batch-missing', 'owner.item.file-parameters.null.batch-item',
  'owner.item.file-parameters.null.batch-signature', 'owner.item.file-parameters.null.batch-read-facts',
  'owner.item.file-parameters.null.origin-none', 'owner.item.file-parameters.null.origin-job-binding',
  'owner.item.file-parameters.null.origin-item', 'owner.item.file-parameters.null.origin-ledger-count',
  'owner.item.file-parameters.null.origin-ledger-asset', 'owner.item.file-parameters.null.parameters',
  'owner.item.file-parameters.throw.input', 'owner.item.file-parameters.throw.binding',
  'owner.item.file-parameters.throw.scan-state', 'owner.item.file-parameters.throw.scan-job',
  'owner.item.file-parameters.throw.source-proof', 'owner.item.file-parameters.throw.batch',
  'owner.item.file-parameters.throw.origin', 'owner.item.file-parameters.throw.parameters',
] as const;
export type CatalogFileParametersBranchStage = typeof CATALOG_FILE_PARAMETERS_BRANCH_STAGES[number];
const CATALOG_ITEM_STAGES = [
  'owner.item.detail', 'owner.item.file-parameters', 'owner.item.title', 'owner.item.segment',
  'owner.item.duration', 'owner.item.audio-map', 'owner.item.availability', 'owner.item.dto',
  'owner.item.artwork', 'owner.item.dto-validation',
] as const;
export const CATALOG_ITEM_METRIC_STAGES = CATALOG_ITEM_STAGES.flatMap(stage =>
  [`${stage}.calls`, `${stage}.total-ms`] as const);
export const CATALOG_TRACE_STAGES = ['main.request','main.owner-await','main.result','core.receive','core.owner-await','core.result',
  'owner.sql.audit','owner.sql.audit-catalog','owner.sql.audit-scan','owner.sql.admission','owner.sql.worker','owner.sql.rollback','owner.sql.connection-close','owner.sql.worker-exit','owner.inventory-reenter','owner.structure-seal',
  'owner.receive','owner.refresh','owner.revision','owner.sql-page','owner.catalog.prepare-fallback','owner.item.detail','owner.item.file-parameters',
  'owner.item.title','owner.item.segment','owner.item.duration','owner.item.audio-map','owner.item.availability',
  'owner.item.close-proof','owner.item.dto','owner.page-seal','owner.result-boundary','owner.reply', ...CATALOG_FILE_PARAMETERS_BRANCH_STAGES,
  ...CATALOG_ITEM_STAGES, ...CATALOG_ITEM_METRIC_STAGES] as const;
export type CatalogTraceStage = typeof CATALOG_TRACE_STAGES[number];
const codes = ['OK','UNKNOWN','BUSY','SOURCE_CHANGED','CONTENT_LIMIT_EXCEEDED','INVALID_REQUEST','INVALID_RESPONSE',
  'RESOURCE_REVOKED','INVENTORY_UNAVAILABLE','UNAVAILABLE','SNAPSHOT_CHANGED','TIMEOUT','NOT_READY'] as const;
export interface CatalogTraceSeed { schema: 1; requestSha256: string; nonceSha256: string; offset: number; limit: number }
export interface CatalogTraceRecord extends CatalogTraceSeed {
  component: 'main'|'core'|'owner'; sequence: number; epochMs: number; elapsedMs: number; rowOrdinal: number|null;
  stage: CatalogTraceStage; phase: 'begin'|'ok'|'reject'; role: 'business'|'cleanup'; code: typeof codes[number];
  matched: boolean|null; count: number|null;
}
const seedKeys = ['schema','requestSha256','nonceSha256','offset','limit'];
const recordKeys = [...seedKeys,'component','sequence','epochMs','elapsedMs','rowOrdinal','stage','phase','role','code','matched','count'];
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown, low: number, high: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= low && v <= high;
function fields(raw: unknown, keys: readonly string[]): Record<string, unknown>|null {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) || ![Object.prototype,null].includes(Object.getPrototypeOf(raw))) return null;
    const d = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(d).length !== keys.length || !keys.every(k => d[k]?.enumerable === true && Object.hasOwn(d[k]!, 'value'))) return null;
    return Object.fromEntries(keys.map(k => [k,d[k]!.value]));
  } catch { return null; }
}
export function copyCatalogTraceSeed(raw: unknown): CatalogTraceSeed|undefined {
  const v = fields(raw,seedKeys);
  return v?.schema === 1 && sha(v.requestSha256) && sha(v.nonceSha256) && integer(v.offset,0,300000) && integer(v.limit,1,100)
    ? Object.freeze(v) as unknown as CatalogTraceSeed : undefined;
}
export function copyCatalogTraceRecord(raw: unknown): CatalogTraceRecord|null {
  const v = fields(raw,recordKeys); if (!v) return null;
  const seed = copyCatalogTraceSeed(Object.fromEntries(seedKeys.map(k => [k,v[k]])));
  if (!seed || !['main','core','owner'].includes(String(v.component)) || !integer(v.sequence,1,64)
    || !integer(v.epochMs,0,Number.MAX_SAFE_INTEGER) || typeof v.elapsedMs !== 'number' || !Number.isFinite(v.elapsedMs) || v.elapsedMs < 0
    || v.rowOrdinal !== null && !integer(v.rowOrdinal,1,100) || !CATALOG_TRACE_STAGES.includes(v.stage as CatalogTraceStage)
    || !['begin','ok','reject'].includes(String(v.phase)) || !['business','cleanup'].includes(String(v.role)) || !codes.includes(v.code as typeof codes[number])
    || v.matched !== null && typeof v.matched !== 'boolean' || v.count !== null && !integer(v.count,0,300000)) return null;
  if (!String(v.stage).startsWith(String(v.component)+'.') || v.phase !== 'reject' && v.code !== 'OK') return null;
  if (v.stage === 'owner.catalog.prepare-fallback' && (v.component !== 'owner' || v.phase !== 'ok'
    || v.role !== 'business' || v.rowOrdinal !== null || v.count !== 1 || v.matched !== false)) return null;
  if (CATALOG_ITEM_METRIC_STAGES.includes(v.stage as typeof CATALOG_ITEM_METRIC_STAGES[number])
    && (v.rowOrdinal !== null || v.count === null || typeof v.matched !== 'boolean'
      || v.phase !== 'ok' || v.role !== 'business')) return null;
  return Object.freeze(v) as unknown as CatalogTraceRecord;
}
interface Context { rowOrdinal: number|null; seed: CatalogTraceSeed; component: CatalogTraceRecord['component']; started: number; sequence: number; bytes: number;
  failures: Set<string>; dropped: number; sink(line: string): void;
  itemMetrics: Map<typeof CATALOG_ITEM_STAGES[number], { calls: number; totalMs: number; clockFailed: boolean }>;
  itemMetricsFlushed: boolean }
const storage = new AsyncLocalStorage<Context|undefined>();
export const captureCatalogTraceSeed = (): CatalogTraceSeed|undefined => storage.getStore()?.seed;
export function withCatalogTrace<T>(raw: unknown, component: Context['component'], work: () => T, sink: (line: string) => void = line => process.stdout.write(line)): T {
  const seed = copyCatalogTraceSeed(raw); if (!seed) return storage.getStore() ? storage.run(undefined, work) : work();
  // 诊断初始化失败不能再次执行原业务；sink错误由emit独立吞掉。
  let started = 0; try { started = performance.now(); } catch { return work(); }
  return storage.run({seed,component,started,sequence:0,bytes:0,failures:new Set(),dropped:0,sink,rowOrdinal:null,
    itemMetrics:new Map(),itemMetricsFlushed:false}, work);
}
/** 每页只发固定十阶段的汇总；total-ms的count是四舍五入毫秒，matched=false表示截限或时钟不可用。 */
function flushCatalogItemMetrics(context: Context): void {
  if (context.component !== 'owner' || context.itemMetricsFlushed) return;
  context.itemMetricsFlushed = true;
  for (const stage of CATALOG_ITEM_STAGES) {
    const metric = context.itemMetrics.get(stage); if (!metric) continue;
    catalogTraceEvent(`${stage}.calls`, 'ok', {rowOrdinal:null,count:Math.min(300000,metric.calls),matched:metric.calls<=300000});
    catalogTraceEvent(`${stage}.total-ms`, 'ok', {rowOrdinal:null,count:Math.min(300000,Math.round(metric.totalMs)),
      matched:!metric.clockFailed && metric.totalMs<=300000});
  }
}
function codeOf(error: unknown): CatalogTraceRecord['code'] {
  try {
    if (!error || typeof error !== 'object' || types.isProxy(error)) return 'UNKNOWN';
    const value = Object.getOwnPropertyDescriptor(error,'code')?.value;
    return codes.includes(value) ? value : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}
export function catalogTraceEvent(stage: CatalogTraceStage, phase: CatalogTraceRecord['phase'], options: {
  error?: unknown; role?: CatalogTraceRecord['role']; rowOrdinal?: number|null; matched?: boolean|null; count?: number|null;
} = {}): void {
  try {
    const c = storage.getStore(); if (!c) return;
    if (stage === 'owner.page-seal' && phase === 'begin') flushCatalogItemMetrics(c);
    const role = options.role ?? 'business', first = phase === 'reject' && !c.failures.has(role);
    if (phase === 'reject' && !first) return;
    if (c.sequence >= 64 || c.sequence >= 58 && !first) { c.dropped++; return; }
    const record = copyCatalogTraceRecord({...c.seed,component:c.component,sequence:c.sequence+1,epochMs:Date.now(),
      elapsedMs:Math.max(0,performance.now()-c.started),rowOrdinal:options.rowOrdinal === undefined ? c.rowOrdinal : options.rowOrdinal,stage,phase,role,
      code:phase === 'reject' ? codeOf(options.error) : 'OK',matched:options.matched ?? null,count:options.count ?? null});
    if (!record) return;
    const line = MOBILE_CATALOG_TRACE_PREFIX + JSON.stringify(record) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > 2048 || c.bytes + bytes > 65536) { c.dropped++; return; }
    c.sequence++; c.bytes += bytes; if (first) c.failures.add(role);
    try { c.sink(line); } catch { /* 写失败也消耗预算，不替换原返回或异常。 */ }
  } catch { /* 私有观察失败不改变业务。 */ }
}
/** 仅注册的Owner行作用域：ok表示旁注已观察，matched=false表示该证明未满足，绝非业务成功。
 * 不占首business reject槽；原外层BUSY/异常仍独立保留。无事实值、异常文本或候选逐行日志。
 */
export function catalogFileParametersBranch(stage: CatalogFileParametersBranchStage): void {
  try {
    const context = storage.getStore();
    if (context?.component !== 'owner' || context.rowOrdinal === null || !CATALOG_FILE_PARAMETERS_BRANCH_STAGES.includes(stage)) return;
    catalogTraceEvent(stage, 'ok', { matched: false });
  } catch { /* 旁注不能替换原null或异常。 */ }
}
export function catalogTraceStep<T>(stage: CatalogTraceStage, work: () => T, rowOrdinal: number|null = null): T {
  const context=storage.getStore(),previous=context?.rowOrdinal ?? null;
  const measuredStage = context?.component === 'owner' && rowOrdinal !== null
    && CATALOG_ITEM_STAGES.includes(stage as typeof CATALOG_ITEM_STAGES[number])
    ? stage as typeof CATALOG_ITEM_STAGES[number] : null;
  let started: number|null = null;
  if (measuredStage !== null) { try { started=performance.now(); } catch { /* 观察不能阻断原业务。 */ } }
  if(context)context.rowOrdinal=rowOrdinal;
  if (rowOrdinal === null) catalogTraceEvent(stage,'begin');
  try { const value = work(); if (rowOrdinal === null) catalogTraceEvent(stage,'ok'); return value; }
  catch(error) { catalogTraceEvent(stage,'reject',{error,rowOrdinal}); throw error; }
  finally {
    if(context)context.rowOrdinal=previous;
    if (context && measuredStage !== null) {
      try {
        const metric=context.itemMetrics.get(measuredStage) ?? {calls:0,totalMs:0,clockFailed:false};
        metric.calls=Math.min(300001,metric.calls+1);
        const elapsed=started===null ? NaN : performance.now()-started;
        if (Number.isFinite(elapsed) && elapsed>=0) metric.totalMs=Math.min(300001,metric.totalMs+elapsed);
        else metric.clockFailed=true;
        context.itemMetrics.set(measuredStage,metric);
      } catch { /* 私有汇总失败不替换返回值或原异常。 */ }
    }
  }
}
export async function catalogTraceAsync<T>(stage: CatalogTraceStage, work: () => Promise<T>): Promise<T> {
  catalogTraceEvent(stage,'begin');
  try { const value = await work(); catalogTraceEvent(stage,'ok'); return value; }
  catch(error) { catalogTraceEvent(stage,'reject',{error}); throw error; }
}
export const MOBILE_CATALOG_MARKER_PREFIX = 'MUSICBRIDGE_MOBILE_CATALOG_MARKER ';
export interface CatalogTraceMarker {
  schema: 'mb.catalog-marker.v1'; requestSha256: string; nonceSha256: string|null; offset: number|null; limit: number|null;
  component: 'main'|'core'|'owner'; kind: 'http-begin'|'nonce-register'|'scope-close'|'http-terminal'; epochMs: number;
  status: number|null; failed: boolean; finished: boolean; count: number; forwarded: number; dropped: number;
}
const markerKeys = ['schema','requestSha256','nonceSha256','offset','limit','component','kind','epochMs','status','failed','finished','count','forwarded','dropped'];
export function copyCatalogTraceMarker(raw: unknown): CatalogTraceMarker|null {
  const v=fields(raw,markerKeys); if(!v || v.schema!=='mb.catalog-marker.v1'||!sha(v.requestSha256)
    || !['main','core','owner'].includes(String(v.component)) || !['http-begin','nonce-register','scope-close','http-terminal'].includes(String(v.kind))
    || !integer(v.epochMs,0,Number.MAX_SAFE_INTEGER) || v.status!==null&&!integer(v.status,100,599)
    || typeof v.failed!=='boolean'||typeof v.finished!=='boolean'||!integer(v.count,0,64)||!integer(v.forwarded,0,64)||Number(v.forwarded)>Number(v.count)||!integer(v.dropped,0,Number.MAX_SAFE_INTEGER))return null;
  const scope=v.kind==='nonce-register'||v.kind==='scope-close';
  if(scope ? !sha(v.nonceSha256)||!integer(v.offset,0,300000)||!integer(v.limit,1,100)
    : v.nonceSha256!==null||v.offset!==null||v.limit!==null||v.component!=='main')return null;
  if(v.kind!=='scope-close'&&v.component!=='main'||v.kind!=='http-terminal'&&(v.status!==null||v.failed||v.finished))return null;
  return Object.freeze(v) as unknown as CatalogTraceMarker;
}
export function emitCatalogTraceMarker(raw: unknown, sink: (line:string)=>void = line=>{process.stdout.write(line);}): void {
  try { const v=copyCatalogTraceMarker(raw);if(v)sink(MOBILE_CATALOG_MARKER_PREFIX+JSON.stringify(v)+'\n'); }catch{/* 旁注不能改变原业务。 */}
}
/** close含本component已发记录数，两流乱序时reader不得把标记先到当成记录齐全。 */
export function withCatalogTraceScope<T>(raw: unknown, component: Context['component'], work:()=>Promise<T>): Promise<T> {
  if(!copyCatalogTraceSeed(raw))return withCatalogTrace(undefined,component,work);
  return withCatalogTrace(raw,component,async()=>{
    try{return await work();}finally{
      const c=storage.getStore();if(c)emitCatalogTraceMarker({...c.seed,schema:'mb.catalog-marker.v1',component,kind:'scope-close',
        epochMs:Date.now(),status:null,failed:false,finished:false,count:c.sequence,forwarded:c.sequence,dropped:c.dropped});
    }
  });
}
/** Main登记的nonce才能接受Core/Owner记录；先保留原seed，失败槽按component/role独立。 */
export function createCatalogTraceRelay(enabled: boolean, sink: (line: string) => void) {
  const seeds = new Map<string,{seed:CatalogTraceSeed;count:number;bytes:number;normal:number;failures:Set<string>;seen:Set<string>;closed:Set<string>;forwarded:Record<string,number>}>();
  let partial = '', discard = false;
  return {
    register(raw: unknown) { if (!enabled) return false; const seed=copyCatalogTraceSeed(raw); if (!seed || seeds.has(seed.nonceSha256)||seeds.size>=32) return false;
      seeds.set(seed.nonceSha256,{seed,count:0,bytes:0,normal:0,failures:new Set(),seen:new Set(),closed:new Set(),forwarded:{core:0,owner:0}}); return true; },
    feed(chunk: string) {
      if(!enabled) return;
      try {
        if(typeof chunk !== 'string' || Buffer.byteLength(chunk)>1024*1024) {partial='';discard=true;return;}
        for(const part of chunk.split(/(?<=\n)/u)) {
          if(!discard) partial+=part;
          if(Buffer.byteLength(partial)>2048){partial='';discard=true;}
          if(!part.endsWith('\n'))continue;
          if(!discard && partial.startsWith(MOBILE_CATALOG_MARKER_PREFIX)) {
            try {
              const row=copyCatalogTraceMarker(JSON.parse(partial.slice(MOBILE_CATALOG_MARKER_PREFIX.length)));
              const state=row?.nonceSha256 ? seeds.get(row.nonceSha256):undefined;
              if(row&&state&&row.kind==='scope-close'&&row.component!=='main'&&row.requestSha256===state.seed.requestSha256
                &&row.offset===state.seed.offset&&row.limit===state.seed.limit&&!state.closed.has(row.component)){
                state.closed.add(row.component);try{sink(MOBILE_CATALOG_MARKER_PREFIX+JSON.stringify({...row,forwarded:state.forwarded[row.component]??0})+'\n');}catch{/* 原业务不变。 */}
                if(state.closed.size===2)seeds.delete(row.nonceSha256!);
              }
            }catch{/* 坏标记不透传。 */}
          }
          if(!discard && partial.startsWith(MOBILE_CATALOG_TRACE_PREFIX)) {
            try {
              const row=copyCatalogTraceRecord(JSON.parse(partial.slice(MOBILE_CATALOG_TRACE_PREFIX.length)));
              const state=row ? seeds.get(row.nonceSha256):undefined;
              if(row && state && row.component!=='main' && row.requestSha256===state.seed.requestSha256 && row.offset===state.seed.offset && row.limit===state.seed.limit) {
                const id=`${row.component}:${row.sequence}`, key=`${row.component}:${row.role}`;
                const first=row.phase==='reject'&&!state.failures.has(key);
                const line=MOBILE_CATALOG_TRACE_PREFIX+JSON.stringify(row)+'\n',bytes=Buffer.byteLength(line);
                if(!state.seen.has(id)&&state.count<64&&state.bytes+bytes<=65536&&(first||row.phase!=='reject'&&state.normal<58)) {
                  state.seen.add(id);state.count++;state.bytes+=bytes;state.forwarded[row.component]=(state.forwarded[row.component]??0)+1;if(first)state.failures.add(key);else state.normal++;
                  try{sink(line);}catch{ /* 旁注出口失败仍消耗配额。 */ }
                }
              }
            }catch{ /* 坏行不透传；只丢本行。 */ }
          }
          partial='';discard=false;
        }
      }catch{partial='';discard=false;}
    },
  };
}

/** 两跳各核自己原envelope nonce，坏旁注只失去诊断，绝不拒绝或重发原业务。 */
export const catalogTraceNonce = (id: string): string => createHash('sha256').update(id).digest('hex');
export function catalogTraceHop(seed: CatalogTraceSeed, requestId: string): unknown {
  return {seed,hopSha256:catalogTraceNonce(requestId)};
}
export function copyCatalogTraceHop(raw: unknown, requestId: string): CatalogTraceSeed|undefined {
  const value=fields(raw,['seed','hopSha256']);
  return value?.hopSha256 === catalogTraceNonce(requestId) ? copyCatalogTraceSeed(value.seed) : undefined;
}
