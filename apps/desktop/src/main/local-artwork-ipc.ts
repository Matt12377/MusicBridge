import { createHash, randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import type { CoreSupervisor } from './core-supervisor.js';
import type { PhotoDecoderImage } from './collection-photos.js';
import { LocalArtworkImageError, normalizeLocalArtwork, readLocalArtworkFile } from './local-artwork-image.js';

type Active = { id: string; cancelled: boolean; abort: AbortController };
/** 闭集通道只接受逻辑目标或图片bytes；路径由原生picker选择，URL/通用抓取/任意owner命令均不开放。 */
export function installLocalArtworkHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void;
  requireTrusted(event: E): void; eventKey(event: E): string;
  supervisor: Pick<CoreSupervisor, 'request' | 'requestInternal'>;
  pick(): Promise<{ canceled: boolean; filePaths: string[] }>;
  decode(bytes: Buffer): PhotoDecoderImage;
  providers?: Partial<Record<dto.LocalArtworkSearchProvider,{ search(query: string, signal: AbortSignal): Promise<Array<{bytes:Uint8Array;source:dto.LocalArtworkRemoteSource}>>; close():void }>>;
}) {
  const active = new Map<string, Active>();
  let closed = false;
  const handle = (channel:string, handler:(event:E,value?:unknown)=>unknown):void => options.handle(channel,async(event,value)=>{
    try { return await handler(event,value); }
    catch { throw new Error('[ARTWORK_UNAVAILABLE] 封面请求未完成，当前封面与音乐库保留；可重新读取或手选图片。'); }
  });
  const publicContext = (v:dto.LocalArtworkContext):dto.LocalArtworkContext => ({...v,remoteProvider:options.providers?.['cover-art-archive-v1'] ? options.providers?.['commons-cc0-v1'] ? 'music-and-commons-v1' : 'cover-art-archive-v1' : options.providers?.['commons-cc0-v1'] ? 'commons-cc0-v1' : 'off-pending-license'});
  const sameTarget = (a:dto.LocalArtworkTarget|null,b:dto.LocalArtworkTarget):boolean => !!a && a.trackId===b.trackId && a.editionId===b.editionId && a.expectedTrackRevision===b.expectedTrackRevision && a.expectedEditionRevision===b.expectedEditionRevision && a.expectedSourceRevision===b.expectedSourceRevision;
  function envelope(event: E, value: unknown, names: readonly string[]) {
    options.requireTrusted(event);
    if (closed) throw new Error('[ARTWORK_CLOSED] 封面服务已关闭，已有选择保留。');
    if (!dto.isLocalArtworkRecord(value, ['datasetId', ...names]) || !dto.isCommandOutboxDatasetId(value.datasetId)) throw new Error('[INVALID_IPC_REQUEST] 封面逻辑请求无效。'); return value;
  }
  const key = (event: E, datasetId: string, target: dto.LocalArtworkTarget) => `${options.eventKey(event)}:${datasetId}:${target.trackId}:${target.editionId}`;
  async function current(datasetId: string) { const value = await options.supervisor.request('commandOutbox.context', {}); if (value.datasetId !== datasetId) throw new Error('[OUTBOX_SCOPE_MISMATCH] 当前工作库已改变。'); }
  async function lookup(event: E, datasetId: string, target: dto.LocalArtworkTarget, run: (entry: Active, alive: () => void) => Promise<dto.LocalArtworkContext | null>) {
    const scope = key(event,datasetId,target);
    if (active.has(scope) || active.size >= 4) throw new Error('[ARTWORK_BUSY] 请等待前一次封面读取结束；现有选择保留。');
    const entry = { id:randomUUID(),cancelled:false,abort:new AbortController() }; active.set(scope,entry);
    const alive = () => { if (entry.cancelled || active.get(scope) !== entry) throw new Error('[ARTWORK_CANCELLED] 封面查找已取消，原选择保留。'); };
    try { await current(datasetId); alive(); return await run(entry,alive); }
    finally { active.delete(scope); }
  }
  async function stage(datasetId: string, target: dto.LocalArtworkTarget, bytes: Uint8Array, origin: dto.LocalArtworkOrigin, sourceIdentity: string, sourceLabel: string, alive: () => void, remoteSource?:dto.LocalArtworkRemoteSource) {
    alive(); const image = normalizeLocalArtwork(bytes,options.decode); alive(); await current(datasetId); alive();
    return publicContext(await options.supervisor.requestInternal('localArtwork.stage', {target,image,origin,sourceIdentity,sourceLabel,...(remoteSource?{remoteSource}:{})},datasetId));
  }
  handle('localArtwork:context', async(event,value) => {
    const v = envelope(event,value,['request']);
    if (!dto.isLocalArtworkCommandPayload('localArtwork.context',v.request)) throw new Error('[INVALID_IPC_REQUEST] 封面读取请求无效。');
    return publicContext(await options.supervisor.request('localArtwork.context',v.request as dto.LocalArtworkCommandPayloads['localArtwork.context'],v.datasetId as string));
  });
  handle('localArtwork:find', async(event,value) => {
    const v = envelope(event,value,['target']); if (!dto.isLocalArtworkTarget(v.target)) throw new Error('[INVALID_IPC_REQUEST] 封面查找目标无效。');
    const target=v.target,datasetId=v.datasetId as string;
    return lookup(event,datasetId,target,async(entry,alive) => {
      const copies=await options.supervisor.requestInternal('localArtwork.readCandidates',{target,lookupId:entry.id},datasetId); alive();
      if (!dto.isLocalArtworkCommandResult('localArtwork.readCandidates',copies)) throw new Error('封面来源结果无效。');
      let context=publicContext(await options.supervisor.request('localArtwork.context',{trackId:target.trackId,editionId:target.editionId},datasetId)); alive();
      for (const item of copies.items) {
        const bytes=Buffer.from(item.base64,'base64'); if (bytes.toString('base64')!==item.base64 || bytes.length>dto.LOCAL_ARTWORK_INPUT_BYTES) throw new Error('封面来源副本无效。');
        try { context=await stage(datasetId,target,bytes,item.origin,item.sourceIdentity,item.sourceLabel,alive); }
        catch(error) { alive(); if (!(error instanceof LocalArtworkImageError)) throw error; /* 坏图片不挡其余候选，原选择保留。 */ }
      }
      alive(); return copies.status==='source-unavailable' && !context.selection?.candidate && !context.candidates.length ? {...context,status:'source-unavailable'} : context;
    });
  });
  handle('localArtwork:pick', async(event,value) => {
    const v=envelope(event,value,['target']); if (!dto.isLocalArtworkTarget(v.target)) throw new Error('[INVALID_IPC_REQUEST] 选图目标无效。'); const target=v.target,datasetId=v.datasetId as string;
    return lookup(event,datasetId,target,async(_entry,alive) => {
      const picked=await options.pick(); alive(); if (picked.canceled) return null;
      if (picked.filePaths.length!==1) throw new Error('请每次选择一张图片。');
      const bytes=await readLocalArtworkFile(picked.filePaths[0]!); alive();
      return stage(datasetId,target,bytes,'manual',createHash('sha256').update(bytes).digest('hex'),'手选图片',alive);
    });
  });
  handle('localArtwork:search',async(event,value) => {
    const fields=dto.isLocalArtworkRecord(value,['datasetId','target','query'])?['target','query']:['target','query','provider'];
    const v=envelope(event,value,fields); if (!dto.isLocalArtworkSearchRequest({target:v.target,query:v.query,...(Object.hasOwn(v,'provider')?{provider:v.provider}:{})})) throw new Error('[INVALID_IPC_REQUEST] 请填写80字以内的封面关键词。');
    if (!dto.isLocalArtworkTarget(v.target) || !dto.isLocalArtworkQuery(v.query)) throw new Error('[INVALID_IPC_REQUEST] 封面检索逻辑目标无效。');
    const target=v.target,datasetId=v.datasetId as string,query=v.query;
    const providerId=(v.provider??'cover-art-archive-v1') as dto.LocalArtworkSearchProvider;
    return lookup(event,datasetId,target,async(entry,alive) => {
      const provider=options.providers?.[providerId]; if (!provider) throw new Error('[ARTWORK_PROVIDER_UNAVAILABLE] 远程封面检索暂不可用，本地选图仍可使用。');
      const context=await options.supervisor.request('localArtwork.context',{trackId:target.trackId,editionId:target.editionId},datasetId); alive();
      if (!dto.isLocalArtworkContext(context) || !sameTarget(context.target,target)) throw new Error('封面目标已变化，请重新读取。');
      const found=await provider.search(query,entry.abort.signal); alive(); let result=publicContext(context);
      if (found.length>2) throw new Error('远程封面候选超出预算。');
      for (const item of found) {
        if (!(providerId==='commons-cc0-v1'?dto.isCommonsArtworkSource(item.source):dto.isCoverArtArchiveSource(item.source)) || item.bytes.length>dto.LOCAL_ARTWORK_INPUT_BYTES) throw new Error('远程封面来源无效。');
        const sourceIdentity=createHash('sha256').update(JSON.stringify([item.source,createHash('sha256').update(item.bytes).digest('hex')])).digest('hex');
        const label=dto.isCommonsArtworkSource(item.source) ? `Wikimedia Commons · ${item.source.title.slice(0,470)}` : `Cover Art Archive · ${item.source.releaseTitle.slice(0,240)} · ${item.source.artist.slice(0,200)}`;
        try { result=await stage(datasetId,target,item.bytes,'provider',sourceIdentity,label,alive,item.source); }
        catch(error) { alive(); if (!(error instanceof LocalArtworkImageError)) throw error; }
      }
      alive(); return result;
    });
  });
  handle('localArtwork:import',async(event,value) => {
    const v=envelope(event,value,['target','bytes']); if (!dto.isLocalArtworkTarget(v.target) || !(v.bytes instanceof Uint8Array) || !(v.bytes.buffer instanceof ArrayBuffer) || v.bytes.length<4 || v.bytes.length>dto.LOCAL_ARTWORK_INPUT_BYTES) throw new Error('[INVALID_IPC_REQUEST] 请拖入一张不超过4 MiB的PNG或JPEG图片。');
    const target=v.target,bytes=Buffer.from(v.bytes),datasetId=v.datasetId as string;
    return lookup(event,datasetId,target,async(_entry,alive) => stage(datasetId,target,bytes,'manual',createHash('sha256').update(bytes).digest('hex'),'拖入图片',alive));
  });
  handle('localArtwork:cancel',async(event,value) => {
    const v=envelope(event,value,['target']); if (!dto.isLocalArtworkTarget(v.target)) throw new Error('[INVALID_IPC_REQUEST] 取消目标无效。');
    const entry=active.get(key(event,v.datasetId as string,v.target)); if (entry) { entry.cancelled=true; entry.abort.abort(); await options.supervisor.requestInternal('localArtwork.cancelLookup',{lookupId:entry.id},v.datasetId as string); }
    return {cancelled:!!entry};
  });
  return { close():void { closed=true; for (const entry of active.values()) { entry.cancelled=true; entry.abort.abort(); } for (const provider of Object.values(options.providers??{})) provider?.close(); } };
}
