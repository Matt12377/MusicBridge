import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import type { LocalCatalogStore } from './local-catalog-store.js';
import { sourceWritesHash, sourceWritesFail, sourceWritesRequestFingerprint, sourceWritesPolicy, sourceWritesEvent, sourceWritesLedgerRow, sourceWritesUnresolvedOperations, type SourceWritesEvent, type SourceWritesReadView, type SourceWritesWriteView, type SourceStoredPlan, type SourceWritesProjection } from './local-source-writes-journal.js';

interface Cursor {datasetId:string;scope:string;offset:number;highWater:number;fingerprint:string;expires:number;values:(dto.LocalSourceWritesPlanSummary|dto.LocalSourceWritesHistoryEvent)[]}
export function createLocalSourceWritesStore(catalog:Pick<LocalCatalogStore,'privateSourceWritesRead'|'privateSourceWritesTransaction'>,now:()=>number=Date.now){
  const cursors=new Map<string,Cursor>();let cursorBytes=0;
  const size=(c:Cursor):number=>{
    // 4096 个合法 journal 事件不扩大公共 maxArray。私有已捕获快照分块编码，合计仍为完整 JSON 字节。
    const {values,...metadata}=c;let bytes=Buffer.byteLength(dto.localSourceWritesCanonical(metadata,2097152,65536,2048,100))+12;
    for(let at=0;at<values.length;at+=1000){const part=dto.localSourceWritesCanonical(values.slice(at,at+1000),2097152,65536,2048,100);bytes+=Buffer.byteLength(part)-2+(at?1:0);if(bytes>2097152)return sourceWritesFail('BUDGET_EXCEEDED');}
    if(bytes>2097152)return sourceWritesFail('BUDGET_EXCEEDED');return bytes;
  };
  const terminal=(s:dto.LocalSourceWritesState):boolean=>['COMPLETED','PARTIAL','FAILED','CANCELLED','BLOCKED'].includes(s);
  // 终结可能包含facts/解决header；按全部六TEXT的最大64KiB预留，不只计算16KiB phase。
  const terminalBytes=(count:number):number=>(count*4+16)*65536;
  function reserve(view:SourceWritesReadView,count:number,extraBytes=0):void{
    let bytes=view.projection.bytes+extraBytes+(count?terminalBytes(count):0);
    for(const p of view.projection.plans.values())if(!terminal(p.plan.state)||sourceWritesUnresolvedOperations(p).length)bytes+=terminalBytes(Math.max(p.items.length,p.plan.resourceSummary.sharedTargets,1));
    if(bytes>67108864)return sourceWritesFail('BUDGET_EXCEEDED');
  }
  const cache=<C extends dto.LocalSourceWritesCommand>(view:SourceWritesReadView,command:C,request:dto.LocalSourceWritesCommandPayloads[C]):Extract<SourceWritesEvent,{kind:'receipt'}>|null=>{
    const id=(request as {commandId?:string}).commandId;if(!id)return null;const e=view.receipt(id,sourceWritesRequestFingerprint(command,request));if(e&&e.kind!=='receipt')return sourceWritesFail('COMMAND_ID_REUSED');if(e&&e.command!==command)return sourceWritesFail('COMMAND_ID_REUSED');return e;
  };
  function plan(view:SourceWritesReadView,datasetId:string,planId:string):SourceStoredPlan{
    const p=view.projection.plans.get(planId);if(!p)return sourceWritesFail('NOT_FOUND');if(p.plan.datasetId!==datasetId)return sourceWritesFail('DATASET_SCOPE_MISMATCH');return p;
  }
  return {
    read<T>(fn:(view:SourceWritesReadView)=>T):T{return catalog.privateSourceWritesRead(fn);},
    transaction<T>(fn:(view:SourceWritesWriteView)=>T):T{return catalog.privateSourceWritesTransaction(fn);},
    receipt<C extends dto.LocalSourceWritesCommand>(command:C,request:dto.LocalSourceWritesCommandPayloads[C]):dto.LocalSourceWritesReceipt|null{return catalog.privateSourceWritesRead(view=>cache(view,command,request)?.receipt??null);},
    policy(datasetId:string):dto.LocalSourceWritesPolicy{return catalog.privateSourceWritesRead(view=>sourceWritesPolicy(view.projection,datasetId));},
    plan(datasetId:string,id:string):SourceStoredPlan{return catalog.privateSourceWritesRead(view=>structuredClone(plan(view,datasetId,id)));},
    capacity(count:number,extraBytes=0):void{catalog.privateSourceWritesRead(v=>reserve(v,count,extraBytes));},
    append(event:SourceWritesEvent,terminalEvent=false):void{catalog.privateSourceWritesTransaction(view=>{
      if(!terminalEvent){const row=sourceWritesLedgerRow(event),bytes=Object.values(row).reduce((n,v)=>n+Buffer.byteLength(v),0);reserve(view,event.kind==='receipt'&&event.header?Math.max(event.header.resourceSummary.sharedTargets,1):0,bytes);}
      if(!terminalEvent&&event.planId){const p=view.projection.plans.get(event.planId);if(p){const operationId=event.kind==='phase'||event.kind==='facts'||event.kind==='directory-facts'?event.fact.operationId:null;if(operationId&&(p.phaseCounts.get(operationId)??0)>=28)return sourceWritesFail('BUDGET_EXCEEDED');if(p.events.length>=4080-p.items.length*4)return sourceWritesFail('BUDGET_EXCEEDED');}}
      view.append(event);
    });},
    state(datasetId:string,planId:string,state:dto.LocalSourceWritesState,issues:dto.LocalSourceWritesIssue[],terminalEvent=false):void{this.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'state' as const,state,issues}),terminalEvent);},
    commandReceipt(datasetId:string,commandId:string,expectedCommand:dto.LocalSourceWritesReceiptCommand,fingerprint:string):dto.LocalSourceWritesReceipt|null{
      return catalog.privateSourceWritesRead(view=>{const e=view.receipt(commandId,fingerprint);if(!e)return null;if(e.kind!=='receipt'||e.command!==expectedCommand||e.datasetId!==datasetId)return sourceWritesFail('COMMAND_ID_REUSED');return structuredClone(e.receipt);});
    },
    history(request:dto.HistoryLocalSourceWrites,publicState?:(stored:SourceStoredPlan,projection:SourceWritesProjection)=>dto.LocalSourceWritesState):dto.LocalSourceWritesHistoryPage{
      return catalog.privateSourceWritesRead(view=>{
        const timestamp=now();for(const[id,c]of cursors)if(c.expires<=timestamp){cursorBytes-=size(c);cursors.delete(id);}
        const scope=sourceWritesHash({datasetId:request.datasetId,selector:request.selector,limit:request.limit});
        let cursor:Cursor;if(request.cursor===null)cursor={datasetId:request.datasetId,scope,offset:0,highWater:view.projection.highWater,fingerprint:view.projection.fingerprint,expires:timestamp+600000,values:[]};
        else{const found=cursors.get(request.cursor);if(!found)return sourceWritesFail('CURSOR_EXPIRED');if(found.scope!==scope||found.datasetId!==request.datasetId)return sourceWritesFail('CURSOR_SCOPE_MISMATCH');cursor=found;}
        const events=view.projection.events.filter(e=>e.datasetId===request.datasetId);let values:(dto.LocalSourceWritesPlanSummary|dto.LocalSourceWritesHistoryEvent)[]=[];
        if(request.cursor!==null)values=cursor.values;
        else if(request.selector.kind==='plans'){const selectedRange=request.selector.range;values=[...view.projection.plans.values()].filter(p=>p.plan.datasetId===request.datasetId&&(selectedRange==='all'||p.plan.range===selectedRange)).map(p=>({planId:p.plan.planId,jobId:p.plan.jobId,viewRevision:p.plan.viewRevision,range:p.plan.range,state:publicState?.(p,view.projection)??p.plan.state,createdAt:p.plan.createdAt,operations:p.items.length,issue:p.plan.issues[0]??null}));}
        else{const selectedId=request.selector.planId;plan(view,request.datasetId,selectedId);values=events.filter(e=>e.planId===selectedId).map(e=>({eventId:e.eventId,planId:selectedId,journalSequence:'1',operationId:e.kind==='phase'||e.kind==='facts'||e.kind==='directory-facts'?e.fact.operationId:null,phase:e.kind==='phase'?e.fact.phase:e.kind==='facts'||e.kind==='directory-facts'?'FACTS_COMMITTED':e.kind==='ready'?'PLANNED':'TERMINAL',occurredAt:e.occurredAt,label:e.kind==='phase'?'源文件阶段已记录':e.kind==='facts'||e.kind==='directory-facts'?'源文件与目录事实已提交':'计划状态已记录',issue:e.kind==='state'?e.issues[0]??null:null}));values.forEach((v,i)=>{(v as dto.LocalSourceWritesHistoryEvent).journalSequence=String(i+1);});}
        if(request.cursor===null){cursor.values=structuredClone(values);size(cursor);}
        const items=structuredClone(values.slice(cursor.offset,cursor.offset+request.limit));let id:string|null=null;const hasMore=cursor.offset+items.length<values.length;
        if(hasMore){const next={...cursor,offset:cursor.offset+items.length},bytes=size(next);if(cursors.size>=128||cursorBytes+bytes>16777216)return sourceWritesFail('BUDGET_EXCEEDED');id=randomUUID();cursors.set(id,next);cursorBytes+=bytes;}
        const common={datasetId:request.datasetId,snapshotFingerprint:cursor.fingerprint,limit:request.limit,cursor:id,hasMore};return request.selector.kind==='plans'?{...common,kind:'plans',range:request.selector.range,items:items as dto.LocalSourceWritesPlanSummary[]}:{...common,kind:'events',planId:request.selector.planId,items:items as dto.LocalSourceWritesHistoryEvent[]};
      });
    },
    close():void{cursors.clear();cursorBytes=0;},
  };
}
export type LocalSourceWritesStore=ReturnType<typeof createLocalSourceWritesStore>;
