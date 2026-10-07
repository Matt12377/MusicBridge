import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import type { LocalCatalogStore } from './local-catalog-store.js';
import { legacyLinksFail, legacyLinksHash, legacyLinksRequestFingerprint, legacyLinksSlotKey, type LegacyLinksEvent, type LegacyLinksView, type LegacyLinksWriteView } from './local-legacy-links-journal.js';

interface Cursor { scope:string; highWater:number; snapshotFingerprint:string; offset:number; expiresAt:number }
export function createLocalLegacyLinksStore(catalog:Pick<LocalCatalogStore,'privateLegacyLinksRead'|'privateLegacyLinksTransaction'>,now:()=>number=Date.now) {
  const cursors=new Map<string,Cursor>();let cursorBytes=0;
  const cursorSize=(c:Cursor):number=>Buffer.byteLength(dto.localLegacyLinksCanonical(c));
  const clean=():void=>{for(const [id,c] of cursors)if(now()>=c.expiresAt){cursorBytes-=cursorSize(c);cursors.delete(id);}};
  const issueCursor=(c:Cursor):string=>{clean();const bytes=cursorSize(c);if(cursors.size>=128||cursorBytes+bytes>16777216)return legacyLinksFail('BUDGET_EXCEEDED');const id=randomUUID();cursors.set(id,c);cursorBytes+=bytes;return id;};
  const scope=(command:string,request:dto.ReadLocalLegacyLinks|dto.HistoryLocalLegacyLinks):string=>{const {cursor,...rest}=request;return legacyLinksHash({command,request:rest});};
  const position=(view:LegacyLinksView,command:string,request:dto.ReadLocalLegacyLinks|dto.HistoryLocalLegacyLinks):Cursor=>{
    const key=scope(command,request);if(request.cursor===null)return {scope:key,highWater:view.events.length,snapshotFingerprint:view.snapshotFingerprint,offset:0,expiresAt:now()+600000};
    const c=cursors.get(request.cursor);if(!c)return legacyLinksFail('CURSOR_EXPIRED');if(now()>=c.expiresAt){clean();return legacyLinksFail('CURSOR_EXPIRED');}if(c.scope!==key)return legacyLinksFail('CURSOR_SCOPE_MISMATCH');return c;
  };
  function page<T>(items:readonly T[],c:Cursor,limit:number):{items:T[];cursor:string|null;hasMore:boolean}{
    const result:T[]=[];let bytes=512,offset=c.offset;
    while(offset<items.length&&result.length<limit){const item=items[offset]!,size=Buffer.byteLength(dto.localLegacyLinksCanonical(item));if(bytes+size>2097152)break;bytes+=size;result.push(structuredClone(item));offset++;}
    if(!result.length&&offset<items.length)return legacyLinksFail('BUDGET_EXCEEDED');const hasMore=offset<items.length;
    return {items:result,cursor:hasMore?issueCursor({...c,offset}):null,hasMore};
  }
  return {
    readView<T>(operation:(view:LegacyLinksView)=>T):T{return catalog.privateLegacyLinksRead(operation);},
    transaction<T>(operation:(view:LegacyLinksWriteView)=>T):T{return catalog.privateLegacyLinksTransaction(operation);},
    receipt(command:dto.LocalLegacyLinksCommand,request:dto.PreviewLocalLegacyLink|dto.ExecuteLocalLegacyLink):LegacyLinksEvent|null {
      return catalog.privateLegacyLinksRead(view=>{const e=view.receipt(request.commandId,legacyLinksRequestFingerprint(command,request));if(e&&e.command!==command)return legacyLinksFail('COMMAND_ID_REUSED');return e;});
    },
    read(request:dto.ReadLocalLegacyLinks):dto.LocalLegacyLinksReadPage {
      return catalog.privateLegacyLinksRead(view=>{
        const c=position(view,'localLegacyLinks.read',request),key=request.selector;
        const atWater:dto.LocalLegacyLink[]=[];let slot:dto.LocalLegacySlotGuard|null=key.by==='legacy'?{activeLinkId:null,lastTransitionEventId:null}:null,slotOrdinal=0;
        for(const events of view.history.values()){
          const last=events.findLast(e=>e.ordinal<=c.highWater);if(!last||last.transition.datasetId!==request.datasetId)continue;const link=last.transition.after,e=link.endpoints;
          if(key.by==='legacy'&&legacyLinksSlotKey(request.datasetId,e)===legacyLinksSlotKey(request.datasetId,key.key)&&last.ordinal>slotOrdinal){slot={activeLinkId:link.state==='active'?link.linkId:null,lastTransitionEventId:link.lastTransitionEventId};slotOrdinal=last.ordinal;}
          const matches=key.by==='link'?link.linkId===key.linkId:key.by==='legacy'?legacyLinksSlotKey(request.datasetId,e)===legacyLinksSlotKey(request.datasetId,key.key)&&(key.key.kind!=='draft-source'||e.kind==='draft-source-track'&&e.sourceBindingId===key.key.sourceBindingId)
            :key.key.kind==='local-edition'?e.kind==='legacy-edition'&&e.localEditionId===key.key.localEditionId:e.kind==='draft-source-track'&&e.localTrackId===key.key.localTrackId&&e.assetId===key.key.assetId;
          if(matches&&(request.state==='all'||link.state==='active'))atWater.push(link);
        }
        atWater.sort((a,b)=>a.linkId<b.linkId?-1:a.linkId>b.linkId?1:0);
        return {datasetId:request.datasetId,selectorFingerprint:legacyLinksHash(request.selector),snapshotFingerprint:c.snapshotFingerprint,limit:request.limit,slot,...page(atWater,c,request.limit)};
      });
    },
    history(request:dto.HistoryLocalLegacyLinks):dto.LocalLegacyLinksHistoryPage {
      return catalog.privateLegacyLinksRead(view=>{const c=position(view,'localLegacyLinks.history',request),events=(view.history.get(request.linkId)??[]).filter(e=>e.ordinal<=c.highWater&&e.transition.datasetId===request.datasetId).map(e=>e.transition);
        return {datasetId:request.datasetId,linkId:request.linkId,snapshotFingerprint:c.snapshotFingerprint,limit:request.limit,...page(events,c,request.limit)};});
    },
    close():void {cursors.clear();cursorBytes=0;},
  };
}
export type LocalLegacyLinksStore=ReturnType<typeof createLocalLegacyLinksStore>;
