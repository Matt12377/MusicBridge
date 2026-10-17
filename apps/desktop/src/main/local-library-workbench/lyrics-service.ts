import https from 'node:https'
import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { types as providerTypes } from 'node:util'
import type { CommonsTransportResponse } from '../commons-artwork-provider.js'
import type { LocalLyricsProviderQuery } from '../../../../../packages/bridge-core/src/collection/local-library-lyrics/types.js'
import { randomUUID } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { captureSourceWritesLyricsGrantRequest, captureSourceWritesLyricsGrantReply, captureSourceWritesLyricsVerifyReply,
  type SourceWritesLyricsGrantRequest, type SourceWritesLyricsGrantReply, type SourceWritesLyricsVerifyReply } from '../../../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { lyricsPhysicalDigest } from '../../../../../packages/bridge-core/src/library/lyrics-source-format.js'
import type { LocalWorkbenchRootMainAuthor, LocalWorkbenchRootAuthorBinding, LocalWorkbenchRootMainRequest,
  LocalWorkbenchMainPreparationContext, LocalWorkbenchRootMainResult } from './service.js'

type Request = Extract<LocalWorkbenchRootMainRequest, { family: 'lyrics' }>
type Context = { signal: AbortSignal; deadlineAtMs: number }
interface Accepted {
  author: LocalWorkbenchRootMainAuthor; binding: Readonly<LocalWorkbenchRootAuthorBinding>; request: Request
  jobResult: dto.LocalLyricsJobSnapshot | null; settled: Promise<void>; resolve(): void; revoked: boolean
}
const sameBinding = (a: Readonly<LocalWorkbenchRootAuthorBinding>, b: Readonly<LocalWorkbenchRootAuthorBinding>) =>
  a.datasetId === b.datasetId && a.ownerEpoch === b.ownerEpoch && a.childGeneration === b.childGeneration && a.authorityRef === b.authorityRef
const pair = (dataset: string, session: string, command: string) => JSON.stringify([dataset,session,command])
const originalJob = (dataset: string, id: string) => JSON.stringify([dataset,id])
const fail = (): never => { throw new Error('歌词原Main授权或原持久回声不一致。') }
/** 这里只保留真实受信UI受理条目；它不是grant品牌，最终资格须查询原物理Owner记录。 */
export function createLocalLyricsMainService(options: {
  currentAuthor(): LocalWorkbenchRootMainAuthor | undefined
  verifyOriginal(request: SourceWritesLyricsGrantRequest, binding: Readonly<LocalWorkbenchRootAuthorBinding>, context: Context): Promise<SourceWritesLyricsVerifyReply>
  now?: () => number
}) {
  const saves = new Map<string,Accepted>(), jobs = new Map<string,Accepted>(), tasks = new Set<Promise<unknown>>()
  const now = options.now ?? Date.now
  let closed = false
  const track = <T>(task: Promise<T>): Promise<T> => { tasks.add(task); void task.then(()=>tasks.delete(task),()=>tasks.delete(task)); return task }
  function actual(context: LocalWorkbenchMainPreparationContext): LocalWorkbenchRootMainAuthor {
    const author = options.currentAuthor()
    if (closed || !author || !sameBinding(author.binding,context.binding) || context.signal.aborted) return fail()
    return author
  }
  function entry(request: Request, author: LocalWorkbenchRootMainAuthor): Accepted {
    let resolve!: () => void; const settled=new Promise<void>(done=>{resolve=done})
    return { author, binding:Object.freeze({...author.binding}), request:structuredClone(request),jobResult:null,settled,resolve,revoked:false }
  }
  function assertEntry(e: Accepted, author: LocalWorkbenchRootMainAuthor): void {
    if (closed || e.revoked || e.author !== author || options.currentAuthor() !== author || !sameBinding(e.binding,author.binding)) return fail()
  }
  async function accept(request: Request, context: LocalWorkbenchMainPreparationContext): Promise<void> {
    if (!dto.isLocalLyricsCommandPayload(request.command,request.payload)) return fail()
    await context.assertCurrent(); const author=actual(context), dataset=context.binding.datasetId
    if (request.command==='localLyrics.save' || request.command==='localLyrics.save.retry') {
      const key=pair(dataset,request.payload.sessionId,request.payload.commandId), prior=saves.get(key)
      if(!prior&&saves.size+jobs.size>=1024)return fail()
      if(prior && prior.author===author && request.command==='localLyrics.save' && prior.request.command==='localLyrics.save'
        && lyricsPhysicalDigest(prior.request.payload)!==lyricsPhysicalDigest(request.payload))return fail()
      saves.set(key,entry(request,author))
    } else if (request.command==='localLyrics.job.start' || request.command==='localLyrics.job.resume' || request.command==='localLyrics.job.retry') {
      const id=request.command==='localLyrics.job.start'?request.payload.commandId:request.payload.jobId
      if(request.command==='localLyrics.job.start'&&request.payload.library.datasetId!==dataset)return fail()
      const key=originalJob(dataset,id),prior=jobs.get(key)
      if(!prior&&saves.size+jobs.size>=1024)return fail()
      if(prior&&prior.author===author&&request.command==='localLyrics.job.start'&&prior.request.command==='localLyrics.job.start'
        &&lyricsPhysicalDigest(prior.request.payload)!==lyricsPhysicalDigest(request.payload))return fail()
      prior?.resolve();jobs.set(key,entry(request,author))
    } else if(request.command==='localLyrics.job.stop') {
      const original=jobs.get(originalJob(dataset,request.payload.jobId));if(original){original.revoked=true;original.resolve()}
    }
    await context.assertCurrent(); actual(context)
  }
  async function observe(request: Request, result: LocalWorkbenchRootMainResult, context: LocalWorkbenchMainPreparationContext): Promise<void> {
    if(!['localLyrics.job.start','localLyrics.job.resume','localLyrics.job.retry'].includes(request.command))return
    const author=actual(context), id=request.command==='localLyrics.job.start'?request.payload.commandId:'jobId'in request.payload?request.payload.jobId:null
    if(!id)return fail()
    const e=jobs.get(originalJob(context.binding.datasetId,id));if(!e)return fail();assertEntry(e,author)
    if(lyricsPhysicalDigest(e.request)!==lyricsPhysicalDigest(request)||!result||typeof result!=='object'||!('jobId'in result)||result.jobId!==id||!('library'in result))return fail()
    // reply已由Main16命令完整guard核收；仍与原UI原库及command一一绑定。
    const job=result as dto.LocalLyricsJobSnapshot
    if(job.library.datasetId!==context.binding.datasetId||request.command==='localLyrics.job.start'&&lyricsPhysicalDigest(job.library)!==lyricsPhysicalDigest(request.payload.library))return fail()
    e.jobResult=structuredClone(job);e.resolve()
  }
  function waitJob(e:Accepted,context:Context):Promise<void>{
    if(e.jobResult)return Promise.resolve()
    return new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);context.signal.removeEventListener('abort',abort);reject(new Error('原job受理回声尚未确认。'))}
      const timer=setTimeout(abort,Math.max(1,context.deadlineAtMs-performance.now()))
      context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted){abort();return}
      void e.settled.then(()=>{clearTimeout(timer);context.signal.removeEventListener('abort',abort);e.jobResult&&!e.revoked?resolve():reject(new Error('原job没有实际受理回声。'))})
    })
  }
  function rejected(q:SourceWritesLyricsGrantRequest):SourceWritesLyricsGrantReply {
    return captureSourceWritesLyricsGrantReply({version:1,type:'lyrics-source-grant-reply',purpose:'LYRICS',requestId:q.requestId,sequence:q.sequence,revision:q.revision,authorityId:q.authorityId,
      requestSha256:lyricsPhysicalDigest(q),binding:q.binding,bindingSha256:q.bindingSha256,decision:'rejected',nonce:null,validUntilMs:null})
  }
  function produce(input:SourceWritesLyricsGrantRequest,context:Context):Promise<SourceWritesLyricsGrantReply>{
    return track((async()=>{
      const q=captureSourceWritesLyricsGrantRequest(input),author=options.currentAuthor(),binding=author?.binding
      const live=()=>{if(closed||!author||!binding||options.currentAuthor()!==author||!sameBinding(author.binding,binding)||binding.datasetId!==q.binding.datasetId||binding.ownerEpoch!==q.binding.ownerEpoch
        ||context.signal.aborted||performance.now()>=context.deadlineAtMs||now()>=q.expiresAtMs)return fail()}
      {
        live();const currentAuthor=author!,currentBinding=binding!
        const save=saves.get(pair(q.binding.datasetId,q.binding.sessionId,q.binding.commandId))
        const anyJob=[...jobs.values()].some(e=>!e.revoked&&e.author===currentAuthor&&sameBinding(e.binding,currentBinding))
        if(!save&&!anyJob)return rejected(q)
        if(save)assertEntry(save,currentAuthor)
        await currentAuthor.assertCurrent(currentBinding);live()
        const echo=captureSourceWritesLyricsVerifyReply(await options.verifyOriginal(q,currentBinding,context));live()
        if(echo.datasetId!==q.binding.datasetId||echo.epoch!==currentBinding.ownerEpoch||echo.grantRequestId!==q.requestId||echo.authorityId!==q.authorityId
          ||echo.bindingSha256!==q.bindingSha256||echo.revision!==q.revision||lyricsPhysicalDigest(echo.binding)!==lyricsPhysicalDigest(q.binding))return fail()
        const evidence=echo.result
        if(evidence.unresolved||evidence.currentOwnerEpoch!==currentBinding.ownerEpoch||evidence.revision!==q.revision
          ||evidence.originalRequestSha256!==lyricsPhysicalDigest(evidence.request)||evidence.originalRequestSha256!==q.binding.originalRequestSha256
          ||evidence.originalIntentSha256!==q.binding.originalIntentSha256||evidence.groupCaptureSha256!==q.binding.groupCaptureSha256||evidence.protectionSha256!==q.binding.protectionSha256)return fail()
        if(q.binding.kind==='embed'&&!evidence.request.embed)return fail()
        if(evidence.jobOrigin===null){
          if(!save)return fail();assertEntry(save,currentAuthor)
          if(save.request.command==='localLyrics.save'){
            if(evidence.phase!=='PREPARED'||lyricsPhysicalDigest(save.request.payload)!==evidence.originalRequestSha256)return fail()
          }else if(save.request.command==='localLyrics.save.retry'){
            if(evidence.phase!=='FAILED'||!evidence.physicalClosed||!evidence.protectionReleased||save.request.payload.sessionId!==evidence.request.sessionId||save.request.payload.commandId!==evidence.request.commandId)return fail()
          }else return fail()
        }else{
          const origin=evidence.jobOrigin,e=jobs.get(originalJob(q.binding.datasetId,origin.jobId));if(!e)return fail();assertEntry(e,currentAuthor)
          if(!['queued','running'].includes(origin.phase))return fail()
          await waitJob(e,context);live();assertEntry(e,currentAuthor)
          if(!e.jobResult||lyricsPhysicalDigest(e.jobResult.library)!==lyricsPhysicalDigest(origin.library)||origin.library.datasetId!==q.binding.datasetId
            ||origin.library.libraryId!==q.binding.libraryId)return fail()
          if(e.request.command==='localLyrics.job.start'&&(lyricsPhysicalDigest(e.request.payload)!==origin.originalJobRequestSha256||e.request.payload.embed!==evidence.request.embed))return fail()
          if(e.request.command==='localLyrics.job.retry'&&!e.request.payload.albumIds.includes(q.binding.albumId))return fail()
          if(!['localLyrics.job.start','localLyrics.job.resume','localLyrics.job.retry'].includes(e.request.command))return fail()
        }
        await currentAuthor.assertCurrent(currentBinding);live()
        return captureSourceWritesLyricsGrantReply({...rejected(q),decision:'granted',nonce:randomUUID(),validUntilMs:now()+480000})
      }
    })())
  }
  return {accept,observe,produce,revoke(){for(const e of [...saves.values(),...jobs.values()]){e.revoked=true;e.resolve()}},
    async close(){closed=true;for(const e of [...saves.values(),...jobs.values()]){e.revoked=true;e.resolve()}await Promise.allSettled([...tasks])},
    pending(){return tasks.size}}
}


export type LocalLyricsProviderState = 'queued'|'running'|'complete'|'failed'|'cancelled'
export type LocalLyricsProviderFailure = 'INVALID_INPUT'|'NOT_READY'|'TIMEOUT'|'NETWORK'|'HTTP_STATUS'|'INVALID_RESPONSE'|'BUDGET'|'CANCELLED'
export type LocalLyricsProviderCall =
  | {command:'lyricsProviderStart';payload:{operationId:string;source:dto.LocalLyricsSource;operation:'search'|'body';input:LocalLyricsProviderQuery|{id:string};expiresAtMs:number}}
  | {command:'lyricsProviderRead';payload:{operationId:string;offset:number}}
  | {command:'lyricsProviderCancel'|'lyricsProviderJoin';payload:{operationId:string}}
export interface LocalLyricsProviderReadResult {
  operationId:string;state:LocalLyricsProviderState;totalBytes:number|null;sha256:string|null;offset:number;bytes:Uint8Array;eof:boolean;failure:LocalLyricsProviderFailure|null
}
export type LocalLyricsProviderResult = {operationId:string;state:LocalLyricsProviderState}|LocalLyricsProviderReadResult
  | {operationId:string;cancelRequested:true}|{operationId:string;physicalClosed:true}
export interface LocalLyricsProviderMainContext {
  binding:Readonly<LocalWorkbenchRootAuthorBinding>;signal:AbortSignal;deadlineAtMs:number
}
class ProviderFailure extends Error {constructor(readonly code:LocalLyricsProviderFailure){super(code)}}
class ProviderClosureFailure extends ProviderFailure {constructor(){super('NOT_READY')}}
const providerFail = (code:LocalLyricsProviderFailure):never=>{throw new ProviderFailure(code)}
const providerUuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)
function providerRecord(v:unknown,fields:readonly string[]):v is Record<string,unknown>{
  if(!v||typeof v!=='object'||providerTypes.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false
  const d=Object.getOwnPropertyDescriptors(v);return Reflect.ownKeys(v).length===fields.length&&fields.every(k=>d[k]?.enumerable===true&&Object.hasOwn(d[k]!, 'value'))
}
function providerInput(operation:'search'|'body',input:unknown):boolean{
  if(operation==='body')return providerRecord(input,['id'])&&typeof input.id==='string'&&/^[A-Za-z0-9_-]{1,160}$/u.test(input.id)
  return providerRecord(input,['title','artist','album','language','version','durationMs'])&&['title','artist','album','language'].every(k=>dto.isLocalLyricsSafeText(input[k],2048))
    &&typeof input.title==='string'&&input.title.trim().length>0&&typeof input.artist==='string'&&input.artist.trim().length>0
    &&['original','live','remix','instrumental','unknown'].includes(String(input.version))&&(input.durationMs===null||Number.isSafeInteger(input.durationMs)&&Number(input.durationMs)>=0)
}
const MAX_PROVIDER_BYTES=1024*1024, PROVIDER_CHUNK=60*1024
/** 静态目的地；Owner/Renderer不能给URL、Cookie、headers、密钥或任意HTTP方法。 */
export function localLyricsProviderUrl(source:dto.LocalLyricsSource,operation:'search'|'body',input:LocalLyricsProviderQuery|{id:string},privateAccessKey?:string):URL{
  if(!dto.LOCAL_LYRICS_SOURCES.includes(source)||!providerInput(operation,input))return providerFail('INVALID_INPUT')
  const query=operation==='search'?input as LocalLyricsProviderQuery:null,id=operation==='body'?(input as {id:string}).id:null
  let url:URL
  switch(source){
    case 'netease':url=new URL(query?'https://music.163.com/api/search/get':'https://music.163.com/api/song/lyric');if(query){url.searchParams.set('s',query.title+' '+query.artist);url.searchParams.set('type','1');url.searchParams.set('limit','40');url.searchParams.set('offset','0')}else{url.searchParams.set('id',id!);url.searchParams.set('lv','-1');url.searchParams.set('kv','-1');url.searchParams.set('tv','-1')}break
    case 'qq':url=new URL(query?'https://c.y.qq.com/soso/fcgi-bin/client_search_cp':'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg');url.searchParams.set('format','json');if(query){url.searchParams.set('w',query.title+' '+query.artist);url.searchParams.set('p','1');url.searchParams.set('n','40')}else{url.searchParams.set('musicid',id!);url.searchParams.set('nobase64','0')}break
    case 'kugou':url=new URL(query?'https://lyrics.kugou.com/search':'https://lyrics.kugou.com/download');url.searchParams.set('ver','1');url.searchParams.set('client','pc');if(query){url.searchParams.set('man','yes');url.searchParams.set('keyword',query.title+' '+query.artist);if(query.durationMs!==null&&query.durationMs>=1000&&query.durationMs<=3600000)url.searchParams.set('duration',String(query.durationMs))}else{if(!privateAccessKey||!/^[-A-Za-z0-9_]{1,512}$/u.test(privateAccessKey))return providerFail('NOT_READY');url.searchParams.set('id',id!);url.searchParams.set('accesskey',privateAccessKey);url.searchParams.set('fmt','lrc');url.searchParams.set('charset','utf8')}break
    case 'kuwo':url=new URL(query?'https://search.kuwo.cn/r.s':'https://www.kuwo.cn/openapi/v1/www/lyric/getlyric');if(query){for(const[k,v]of Object.entries({all:query.title+' '+query.artist,ft:'music',client:'kt',pn:'0',rn:'40',rformat:'json',encoding:'utf8',mobi:'1',vipver:'1'}))url.searchParams.set(k,v)}else url.searchParams.set('musicId',id!);break
    case 'lrclib':url=new URL(query?'https://lrclib.net/api/search':'https://lrclib.net/api/get/'+encodeURIComponent(id!));if(query){url.searchParams.set('track_name',query.title);url.searchParams.set('artist_name',query.artist);if(query.album)url.searchParams.set('album_name',query.album)}break
  }
  return url
}
function lyricsPublicAddress(address:string):boolean{
  if(isIP(address)===4){const[a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a!>=224||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===100&&b!>=64&&b!<=127||a===192&&(b===0||b===168||b===88&&c===99||b===31&&c===196||b===52&&c===193||b===175&&c===48)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113)}
  if(isIP(address)!==6||address.includes('%')||address.includes('.'))return false
  const sides=address.toLowerCase().split('::'),left=sides[0]?sides[0].split(':'):[],right=sides[1]?sides[1].split(':'):[],words=(sides.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(word=>parseInt(word,16)),first=words[0]!,second=words[1]!
  return(first&0xe000)===0x2000&&!(first===0x2001&&(second<0x200||second===0xdb8))&&first!==0x2002&&first!==0x3ffe&&(first!==0x3fff||second>=0x1000)
}
/** 固定HTTPS+公网DNS固定地址；全部request/response close之后才settle，不自动重试/redirect。 */
async function nativeLyricsTransport(url:URL,signal:AbortSignal):Promise<CommonsTransportResponse>{
  if(!['music.163.com','c.y.qq.com','lyrics.kugou.com','search.kuwo.cn','www.kuwo.cn','lrclib.net'].includes(url.hostname)||url.protocol!=='https:'||url.port||url.username||url.password||url.hash)return providerFail('INVALID_INPUT')
  const resolver=new Resolver(),cancel=()=>resolver.cancel();signal.addEventListener('abort',cancel,{once:true});const dnsTimer=setTimeout(cancel,3000)
  let addresses:Array<{address:string;family:4|6}>=[]
  try{if(signal.aborted)return providerFail('CANCELLED');const replies=await Promise.allSettled([resolver.resolve4(url.hostname),resolver.resolve6(url.hostname)]);for(let i=0;i<replies.length;i++){const reply=replies[i]!;if(reply.status==='fulfilled')addresses.push(...reply.value.map(address=>({address,family:(i===0?4:6)as 4|6})));else if(!['ENODATA','ENOTFOUND'].includes(String(reply.reason?.code)))return providerFail('NETWORK')}}finally{clearTimeout(dnsTimer);signal.removeEventListener('abort',cancel)}
  if(signal.aborted)return providerFail('CANCELLED');if(!addresses.length||addresses.length>32||addresses.some(v=>isIP(v.address)!==v.family||!lyricsPublicAddress(v.address)))return providerFail('NETWORK');const selected=addresses[0]!
  return new Promise<CommonsTransportResponse>((resolve,reject)=>{
    let response:import('node:http').IncomingMessage|undefined,delivered=false,requestDone!:()=>void
    const requestClosed=new Promise<void>(done=>{requestDone=done})
    const requestOptions: https.RequestOptions & { autoSelectFamily: false } = {method:'GET',agent:false,autoSelectFamily:false,family:selected.family,servername:url.hostname,rejectUnauthorized:true,maxHeaderSize:8192,
      lookup:(host,_options,callback)=>{host===url.hostname?callback(null,selected.address,selected.family):callback(new Error('固定来源主机不符'),'',selected.family)},
      headers:{'User-Agent':'MusicBridge/3.9 local-lyrics','Accept':'application/json, text/plain','Accept-Encoding':'identity',...(url.hostname==='c.y.qq.com'?{Referer:'https://y.qq.com/'}:{})}}
    const request=https.request(url,requestOptions)
    const abort=()=>{response?.destroy();request.destroy(new Error('来源请求取消'))}
    request.once('close',()=>{requestDone();if(!delivered){signal.removeEventListener('abort',abort);reject(new ProviderFailure('NETWORK'))}})
    request.once('error',()=>{if(!delivered)void requestClosed.then(()=>reject(new ProviderFailure('NETWORK')))})
    request.once('socket',socket=>socket.once('secureConnect',()=>{if(!socket.remoteAddress||socket.remoteAddress!==selected.address||!lyricsPublicAddress(socket.remoteAddress))request.destroy(new Error('固定来源地址不符'))}))
    request.once('response',incoming=>{response=incoming;const responseClosed=new Promise<void>(done=>incoming.once('close',done));delivered=true;resolve({statusCode:incoming.statusCode??0,headers:incoming.headers,body:incoming,destroy(){incoming.destroy();request.destroy()},closed:Promise.all([requestClosed,responseClosed]).then(()=>signal.removeEventListener('abort',abort))});if(signal.aborted)abort()})
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else request.end()
  })
}
interface ProviderOperation {author:LocalWorkbenchRootMainAuthor;binding:Readonly<LocalWorkbenchRootAuthorBinding>;original:string;controller:AbortController;state:LocalLyricsProviderState;raw:Buffer|null;sha256:string|null;failure:LocalLyricsProviderFailure|null;physicalClosed:boolean;closureFailed:boolean;expiresAtMs:number;joined:boolean;task:Promise<void>}
/** 单一Main bridge；start早返回实际任务，read只读完整结果，cancel与join分开。 */
export function createLocalLyricsMainProviderBridge(options:{currentAuthor():LocalWorkbenchRootMainAuthor|undefined;transport?:(url:URL,signal:AbortSignal)=>Promise<CommonsTransportResponse>;now?:()=>number}){
  const operations=new Map<string,ProviderOperation>(),privateCandidates=new Map<string,{author:LocalWorkbenchRootMainAuthor;source:dto.LocalLyricsSource;id:string;key:string|null;expiresAtMs:number}>(),transport=options.transport??nativeLyricsTransport,clock=options.now??Date.now
  let closed=false
  function live(context:LocalLyricsProviderMainContext):LocalWorkbenchRootMainAuthor{const author=options.currentAuthor();if(closed||!author||!sameBinding(author.binding,context.binding)||context.signal.aborted||performance.now()>=context.deadlineAtMs)return providerFail('NOT_READY');return author}
  function scoped(id:string,author:LocalWorkbenchRootMainAuthor):ProviderOperation{const op=operations.get(id);if(!op||op.author!==author||!sameBinding(op.binding,author.binding))return providerFail('NOT_READY');return op}
  function normalizedSearch(source:dto.LocalLyricsSource,body:unknown,author:LocalWorkbenchRootMainAuthor):unknown{
    const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
    const root=record(body)
    if(source==='netease'){if(root.code!==200||!Array.isArray(record(root.result).songs))return providerFail('INVALID_RESPONSE');return body}
    if(source==='lrclib'){if(!Array.isArray(body))return providerFail('INVALID_RESPONSE');return body}
    const remember=(id:unknown,key:unknown=null)=>{if(typeof id!=='string'&&!(typeof id==='number'&&Number.isSafeInteger(id)))return providerFail('INVALID_RESPONSE');const real=String(id);if(!/^[A-Za-z0-9_-]{1,160}$/u.test(real)||key!==null&&(typeof key!=='string'||!/^[-A-Za-z0-9_]{1,512}$/u.test(key)))return providerFail('INVALID_RESPONSE');if(privateCandidates.size>=2048)return providerFail('BUDGET');const opaque=randomUUID();privateCandidates.set(opaque,{author,source,id:real,key:key as string|null,expiresAtMs:clock()+15000});return opaque}
    if(source==='qq'){const rows=record(record(root.data).song).list;if(root.code!==0||!Array.isArray(rows))return providerFail('INVALID_RESPONSE');return{data:{song:{list:rows.map(v=>{const r=record(v);return{mid:remember(r.songid??r.id),name:r.name??r.songname,singer:r.singer,albumname:r.albumname??record(r.album).name,interval:r.interval}})}}}}
    if(source==='kugou'){if(root.status!==200||!Array.isArray(root.candidates))return providerFail('INVALID_RESPONSE');return{data:{info:root.candidates.map(v=>{const r=record(v);return{hash:remember(r.id,r.accesskey),songname:r.song,singername:r.singer,album_name:'',duration:typeof r.duration==='number'?r.duration/1000:null}})}}}
    const rows=root.abslist;if(!Array.isArray(rows)&&root.TOTAL!=='0')return providerFail('INVALID_RESPONSE');return{data:{list:(rows as unknown[]??[]).map(v=>{const r=record(v),rid=String(r.MUSICRID??'').replace(/^MUSIC_/u,'');return{rid:remember(rid),name:r.NAME,artist:r.ARTIST,album:r.ALBUM??'',duration:typeof r.DURATION==='string'?Number(r.DURATION):r.DURATION}})}}
  }
  async function fetchBody(source:dto.LocalLyricsSource,operation:'search'|'body',input:LocalLyricsProviderQuery|{id:string},author:LocalWorkbenchRootMainAuthor,signal:AbortSignal):Promise<Buffer>{
    let actual=input,key:string|undefined
    if(operation==='body'&&['qq','kugou','kuwo'].includes(source)){const item=privateCandidates.get((input as{id:string}).id);if(!item||item.author!==author||item.source!==source)return providerFail('NOT_READY');actual={id:item.id};key=item.key??undefined}
    const url=localLyricsProviderUrl(source,operation,actual,key),response=await transport(url,signal)
    try{
      if(response.statusCode!==200)return providerFail('HTTP_STATUS')
      const encoding=response.headers['content-encoding'];if(encoding!==undefined&&encoding!=='identity')return providerFail('INVALID_RESPONSE')
      const size=response.headers['content-length'];if(size!==undefined&&(typeof size!=='string'||!/^[0-9]+$/u.test(size)||!Number.isSafeInteger(Number(size))||Number(size)>MAX_PROVIDER_BYTES))return providerFail('BUDGET')
      const mime=response.headers['content-type'];if(typeof mime!=='string'||!['application/json','text/json','text/plain','text/javascript'].includes(mime.split(';')[0]!.trim().toLowerCase()))return providerFail('INVALID_RESPONSE')
      let total=0;const chunks:Buffer[]=[]
      for await(const chunk of response.body){if(signal.aborted)return providerFail('CANCELLED');total+=chunk.byteLength;if(total>MAX_PROVIDER_BYTES)return providerFail('BUDGET');chunks.push(Buffer.from(chunk))}
      if(signal.aborted)return providerFail('CANCELLED');const raw=Buffer.concat(chunks);if(size!==undefined&&raw.length!==Number(size))return providerFail('INVALID_RESPONSE')
      let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))}catch{return providerFail('INVALID_RESPONSE')}
      const normalized=operation==='search'?normalizedSearch(source,parsed,author):parsed
      const out=Buffer.from(JSON.stringify(normalized),'utf8');if(out.length>MAX_PROVIDER_BYTES)return providerFail('BUDGET');return out
    }finally{let failed=false;try{response.destroy()}catch{failed=true}try{await response.closed}catch{failed=true}if(failed)throw new ProviderClosureFailure()}
  }
  async function execute(call:LocalLyricsProviderCall,context:LocalLyricsProviderMainContext):Promise<LocalLyricsProviderResult>{
    // 关闭阶段仅原已登记operation允许cancel/join；这条清理路径不授新读取或源写许可。
    if (providerRecord(call,['command','payload']) && (call.command==='lyricsProviderCancel'||call.command==='lyricsProviderJoin')) {
      if (!providerRecord(call.payload,['operationId'])||!providerUuid(call.payload.operationId)||context.signal.aborted||performance.now()>=context.deadlineAtMs) return providerFail('INVALID_INPUT')
      const original=operations.get(call.payload.operationId)
      if (!original||!sameBinding(original.binding,context.binding)) return providerFail('NOT_READY')
      if (call.command==='lyricsProviderCancel') { original.controller.abort('cancelled');return {operationId:call.payload.operationId,cancelRequested:true} }
      await original.task
      if (context.signal.aborted||performance.now()>=context.deadlineAtMs||!original.physicalClosed) return providerFail('NOT_READY')
      original.joined=true;return {operationId:call.payload.operationId,physicalClosed:true}
    }
    const author=live(context)
    await author.assertCurrent(context.binding);live(context)
    for(const[id,op]of operations)if(op.joined&&op.expiresAtMs<=clock())operations.delete(id)
    for(const[id,item]of privateCandidates)if(item.expiresAtMs<=clock())privateCandidates.delete(id)
    if(!providerRecord(call,['command','payload']))return providerFail('INVALID_INPUT')
    if(call.command==='lyricsProviderStart'){
      const p=call.payload
      if(!providerRecord(p,['operationId','source','operation','input','expiresAtMs'])||!providerUuid(p.operationId)||!dto.LOCAL_LYRICS_SOURCES.includes(p.source)||!['search','body'].includes(p.operation)||!providerInput(p.operation,p.input)||!Number.isSafeInteger(p.expiresAtMs)||p.expiresAtMs<=clock()||p.expiresAtMs>clock()+15000)return providerFail('INVALID_INPUT')
      const original=lyricsPhysicalDigest(p),prior=operations.get(p.operationId);if(prior){if(prior.author!==author||prior.original!==original||!sameBinding(prior.binding,context.binding))return providerFail('INVALID_INPUT');return{operationId:p.operationId,state:prior.state}}
      if([...operations.values()].filter(op=>!op.physicalClosed).length>=128)return providerFail('BUDGET')
      const controller=new AbortController(),op:ProviderOperation={author,binding:Object.freeze({...context.binding}),original,controller,state:'queued',raw:null,sha256:null,failure:null,physicalClosed:false,closureFailed:false,expiresAtMs:p.expiresAtMs,joined:false,task:Promise.resolve()}
      const timer=setTimeout(()=>controller.abort('timeout'),Math.max(1,p.expiresAtMs-clock()))
      op.task=Promise.resolve().then(async()=>{op.state='running';const raw=await fetchBody(p.source,p.operation,p.input,author,controller.signal);if(closed||options.currentAuthor()!==author||!sameBinding(author.binding,op.binding)||controller.signal.aborted)return providerFail('CANCELLED');if([...operations.values()].reduce((sum,item)=>sum+(item.raw?.length??0),0)+raw.length>32*1024*1024)return providerFail('BUDGET');op.raw=raw;op.sha256=createHash('sha256').update(raw).digest('hex');op.state='complete'})
        .catch(error=>{op.closureFailed=error instanceof ProviderClosureFailure;op.raw=null;op.sha256=null;op.failure=controller.signal.aborted?(controller.signal.reason==='timeout'?'TIMEOUT':'CANCELLED'):error instanceof ProviderFailure?error.code:'NETWORK';op.state=op.failure==='CANCELLED'?'cancelled':'failed'})
        .finally(()=>{clearTimeout(timer);op.physicalClosed=!op.closureFailed})
      operations.set(p.operationId,op);return{operationId:p.operationId,state:op.state}
    }
    if(call.command!=='lyricsProviderRead'||!providerRecord(call.payload,['operationId','offset'])||!providerUuid(call.payload.operationId))return providerFail('INVALID_INPUT')
    const p=call.payload,op=scoped(p.operationId,author),offset=p.offset;if(!Number.isSafeInteger(offset)||offset<0||offset>(op.raw?.length??0))return providerFail('INVALID_INPUT')
    const raw=op.raw,bytes=raw?new Uint8Array(raw.subarray(offset,offset+PROVIDER_CHUNK)):new Uint8Array()
    return{operationId:p.operationId,state:op.state,totalBytes:raw?.length??null,sha256:op.sha256,offset,bytes,eof:op.state==='complete'&&offset+bytes.length===raw!.length,failure:op.failure}
  }
  return{execute,
    async revokeOwner(binding:Readonly<LocalWorkbenchRootAuthorBinding>){const owned=[...operations.values()].filter(op=>sameBinding(op.binding,binding));for(const op of owned)op.controller.abort('cancelled');await Promise.allSettled(owned.map(op=>op.task));if(owned.some(op=>!op.physicalClosed))return providerFail('NOT_READY')},
    async close(){closed=true;for(const op of operations.values())op.controller.abort('cancelled');await Promise.allSettled([...operations.values()].map(op=>op.task));if([...operations.values()].some(op=>!op.physicalClosed))return providerFail('NOT_READY');privateCandidates.clear()},
    pending(){return[...operations.values()].filter(op=>!op.physicalClosed).length}}
}
