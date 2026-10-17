import { randomUUID } from 'node:crypto'
import type { LocalWorkbenchAvailability } from '@music-bridge/contracts'
import type { LocalArtworkAvailabilityContext } from './artwork-providers.js'
import { abortable, checkSignal, deadline, fail, safeProviderError } from './boundaries.js'
import { artworkWebUrl, checkedRemoteArtworkUrl, type LocalArtworkWebSource } from './artwork-urls.js'

export interface LocalArtworkWebNavigationOptions {
  /** 受控的应用内浏览器导航端口；捕获ID仅由本进程原导航生成，不消费网页或Renderer自定ID。 */
  navigate?(checkedUrl: URL, context: { signal: AbortSignal; captureId: string; hostIdentity?: string }): void | Promise<void>
  /** 同原captureId/signal的自有窗口reload；不得新建窗口或加载另一查询。 */
  refresh?(checkedUrl: URL, context: { signal: AbortSignal; originalSignal: AbortSignal; captureId: string; hostIdentity?: string }): void | Promise<void>
  openExternal?(checkedUrl: URL, context: { signal: AbortSignal }): void | Promise<void>
  /** 读取原Root窗口/显式shell资源闭包；不打开网页，不以端口函数存在代替alive。 */
  readPortAvailability?(mode: 'navigate' | 'refresh' | 'openExternal', signal: AbortSignal): boolean | Promise<boolean>
}
export interface LocalArtworkWebRequest { source: LocalArtworkWebSource; query: string; originalCaptureKey?: string; hostIdentity?: string }
export type LocalArtworkNavigationResult = { opened: true } | { opened: false; reason: string }
export interface LocalArtworkCapturedImage { url: string; ageMs: number }
interface OwnedNavigationPhysical {
  closed: Promise<void>
  abort(): void
  readCapturedImage?(dragRef:string): Promise<LocalArtworkCapturedImage | null>
}

export interface TrackedLocalArtworkWebNavigation {
  readAvailability(mode: 'navigate' | 'refresh' | 'openExternal', source: LocalArtworkWebSource, context: LocalArtworkAvailabilityContext): Promise<LocalWorkbenchAvailability>
  navigate(request:LocalArtworkWebRequest,signal?:AbortSignal):Promise<LocalArtworkNavigationResult>
  refresh(request:LocalArtworkWebRequest,signal?:AbortSignal):Promise<LocalArtworkNavigationResult>
  openExternal(request:LocalArtworkWebRequest,signal?:AbortSignal):Promise<LocalArtworkNavigationResult>
  consumeCapturedImage(originalCaptureKey:string,dragRef:string,signal:AbortSignal):Promise<LocalArtworkCapturedImage|null>
  join(operation:Promise<LocalArtworkNavigationResult>):Promise<void>
  cancelOriginal(operation:Promise<LocalArtworkNavigationResult>):Promise<void>
  close():Promise<void>
}
interface OriginalNavigationPhysical {
  accepting:boolean
  source:LocalArtworkWebSource
  url:string
  captureEpoch:number
  refreshing:boolean
  external:boolean
  signal:AbortSignal
  originalCaptureKey:string|null
  hostIdentity:string|undefined
  captureId:string
  opened:boolean
  captureRevoked:boolean
  lastConsumedSequence:number
  ownedClosed:boolean
  owned:OwnedNavigationPhysical|null
  reads:Set<Promise<LocalArtworkCapturedImage|null>>
  revokeCapture():void
}
const originalNavigationPhysical=new WeakMap<AbortSignal,OriginalNavigationPhysical>()
/** 仅原factory所持signal可登记一次自有window/图片读取口；Root用实际closed，图片端口不自动导入。 */
export function registerLocalArtworkNavigationPhysical(signal:AbortSignal,owned:OwnedNavigationPhysical):void{
  const original=originalNavigationPhysical.get(signal)
  if(!original||original.external||!original.accepting||original.owned||!(owned.closed instanceof Promise)||typeof owned.abort!=='function'
    ||owned.readCapturedImage!==undefined&&(typeof owned.readCapturedImage!=='function'||original.originalCaptureKey===null))return fail('closed')
  original.owned={closed:owned.closed,abort:owned.abort,...(owned.readCapturedImage?{readCapturedImage:owned.readCapturedImage.bind(owned)}:{})}
  // logical opened之后仍保存这条原窗口abort，直到实际closed；不关用户外部浏览器。
  signal.addEventListener('abort',owned.abort,{once:true});if(signal.aborted)owned.abort()
  void owned.closed.then(()=>{original.ownedClosed=true;original.revokeCapture()},()=>original.revokeCapture())
}
const navigationBrands=new WeakSet<object>()
export const isTrackedLocalArtworkWebNavigation=(value:unknown):value is TrackedLocalArtworkWebNavigation=>value!==null&&typeof value==='object'&&navigationBrands.has(value)
const captureKey=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)
const imageDragReference=(value:unknown):{id:string;sequence:number}|null=>{
  if(typeof value!=='string')return null
  const match=/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([1-9][0-9]{0,5})$/u.exec(value)
  return match?{id:match[1]!,sequence:Number(match[2])}:null
}

export function createLocalArtworkWebNavigation(options:LocalArtworkWebNavigationOptions):TrackedLocalArtworkWebNavigation {
  let closed=false,closure:Promise<void>|undefined,closureDone=false,physicalUnknown=false
  const originalNavigate=options.navigate,originalRefresh=options.refresh,originalExternal=options.openExternal,portAvailability=options.readPortAvailability
  const unavailable=(reason:string):LocalWorkbenchAvailability=>({available:false,reason})
  const active=new Set<AbortController>(),physicalTasks=new Set<Promise<void>>()
  const joins=new WeakMap<Promise<LocalArtworkNavigationResult>,Promise<void>>(),controllers=new WeakMap<Promise<LocalArtworkNavigationResult>,AbortController>()
  const captures=new Map<string,OriginalNavigationPhysical>(),cancelJoins=new WeakMap<Promise<LocalArtworkNavigationResult>,Promise<void>>()
  const open=(request:LocalArtworkWebRequest,external:boolean,parent?:AbortSignal):Promise<LocalArtworkNavigationResult>=>{
    let url:URL
    try{if(closed)return fail('closed');if(active.size>=24)return fail('busy');url=artworkWebUrl(request.source,request.query)
      if(request.originalCaptureKey!==undefined&&!captureKey(request.originalCaptureKey))return fail('input');if(request.hostIdentity!==undefined&&(typeof request.hostIdentity!=='string'||request.hostIdentity.length<1||request.hostIdentity.length>4096))return fail('input')}
    catch(error){const operation=Promise.reject<LocalArtworkNavigationResult>(error);joins.set(operation,Promise.resolve());return operation}
    const port=external?options.openExternal:options.navigate
    if(!port){const operation=Promise.resolve<LocalArtworkNavigationResult>({opened:false,reason:external?'外部网页入口尚未接入。':'应用内网页入口尚未接入。'});joins.set(operation,Promise.resolve());return operation}
    const scope=deadline(parent,15_000),key=external?null:request.originalCaptureKey??null
    const resource:OriginalNavigationPhysical={accepting:true,source:request.source,url:url.href,captureEpoch:0,refreshing:false,external,signal:scope.signal,originalCaptureKey:key,hostIdentity:request.hostIdentity,captureId:randomUUID(),opened:false,
      captureRevoked:false,lastConsumedSequence:0,ownedClosed:false,owned:null,reads:new Set(),
      revokeCapture(){resource.captureRevoked=true;if(key!==null&&captures.get(key)===resource)captures.delete(key)}}
    originalNavigationPhysical.set(scope.signal,resource);active.add(scope.controller)
    scope.signal.addEventListener('abort',resource.revokeCapture,{once:true})
    // scope.dispose只结束原15s导航时钟；原window仍活时，原parent取消继续撤销其捕获与自有窗口。
    const parentAbort=()=>scope.controller.abort('provider-cancelled')
    parent?.addEventListener('abort',parentAbort,{once:true})
    if(key!==null){const previous=captures.get(key);captures.set(key,resource)
      if(previous){previous.revokeCapture();controllersForResource.get(previous)?.abort('provider-cancelled')}}
    controllersForResource.set(resource,scope.controller)
    if(parent?.aborted)parentAbort()
    let invoked=false
    // 只保原自有启动Promise；不关闭用户外部浏览器，也不把abortable包装当producer join。
    const portContext={signal:scope.signal,...(!external?{captureId:resource.captureId}:{})}
    const producer=Promise.resolve().then(()=>{checkSignal(scope.signal);invoked=true;return external
      ?(port as NonNullable<LocalArtworkWebNavigationOptions['openExternal']>)(url,portContext)
      :(port as NonNullable<LocalArtworkWebNavigationOptions['navigate']>)(url,{signal:scope.signal,captureId:resource.captureId,...(resource.hostIdentity?{hostIdentity:resource.hostIdentity}:{})})})
    const operation=abortable(producer,scope.signal).then(()=>{checkSignal(scope.signal);if(closed)return fail('cancelled');resource.opened=true;return {opened:true as const}})
      .catch(error=>{resource.revokeCapture();throw safeProviderError(error,scope.signal)}).finally(()=>scope.dispose())
    const physical=producer.then(()=>true,()=>false).then(async succeeded=>{
      resource.accepting=false
      if(invoked){if(external){if(!succeeded)return fail('closed')}else{
        if(!resource.owned)return fail('closed')
        let windowClosed=true
        try{await resource.owned.closed}catch{windowClosed=false}
        resource.revokeCapture()
        // closed后的新consume已封；所有原图片producer必须settled后，同window的join才可完成。
        await Promise.allSettled([...resource.reads])
        if(!windowClosed)return fail('closed')
      }}
      if(resource.owned)scope.signal.removeEventListener('abort',resource.owned.abort)
      active.delete(scope.controller);physicalTasks.delete(physical)
    }).finally(()=>{resource.revokeCapture();scope.signal.removeEventListener('abort',resource.revokeCapture);parent?.removeEventListener('abort',parentAbort)})
    joins.set(operation,physical);controllers.set(operation,scope.controller);physicalTasks.add(physical);void physical.catch(()=>{physicalUnknown=true})
    return operation
  }
  const controllersForResource=new WeakMap<OriginalNavigationPhysical,AbortController>()
  const currentCapture=(resource:OriginalNavigationPhysical,key:string,id:string)=>!closed&&!resource.external&&resource.opened&&!resource.captureRevoked
    &&!resource.signal.aborted&&!resource.ownedClosed&&resource.originalCaptureKey===key&&resource.captureId===id&&captures.get(key)===resource
  function availabilityBlock(mode:'navigate'|'refresh'|'openExternal',source:LocalArtworkWebSource):LocalWorkbenchAvailability|null{
    if(!['navigate','refresh','openExternal'].includes(mode))return unavailable('网页入口不在原闭集内。')
    if(physicalUnknown)return unavailable('原网页producer或自有窗口关闭尚未确认。')
    if(closed)return unavailable(closureDone?'网页资源已经关闭。':'网页资源正在关闭。')
    if(active.size>=24)return unavailable('原网页资源达到24项预算。')
    if(options.navigate!==originalNavigate||options.refresh!==originalRefresh||options.openExternal!==originalExternal||options.readPortAvailability!==portAvailability)
      return unavailable('原网页资源配置已经改变。')
    if(!(mode==='navigate'?originalNavigate:mode==='refresh'?originalRefresh:originalExternal)||typeof portAvailability!=='function')return unavailable('原网页资源状态接口尚未建立。')
    try{artworkWebUrl(source,'配置检查')}catch{return unavailable('网页来源不在原固定策略内。')}
    return null
  }
  const navigation:TrackedLocalArtworkWebNavigation={
    async readAvailability(mode,source,context){
      if(this!==navigation||!context||!(context.signal instanceof AbortSignal)||typeof context.assertCurrent!=='function')return unavailable('原网页作者尚未建立。')
      const originalSignal=context.signal,originalAssert=context.assertCurrent
      try{
        checkSignal(originalSignal);await originalAssert.call(context);checkSignal(originalSignal)
        if(context.signal!==originalSignal||context.assertCurrent!==originalAssert)return unavailable('原网页读取上下文已经换代。')
        const blocked=availabilityBlock(mode,source);if(blocked)return blocked
        const ready=await abortable(Promise.resolve(portAvailability!(mode,originalSignal)),originalSignal)===true
        await originalAssert.call(context);checkSignal(originalSignal)
        if(context.signal!==originalSignal||context.assertCurrent!==originalAssert)return unavailable('原网页读取上下文已经换代。')
        const after=availabilityBlock(mode,source);if(after)return after
        return ready?{available:true}:unavailable('原网页资源未确认可调用。')
      }catch{return unavailable('原网页作者或读取信号已撤销。')}
    },
    navigate(request,signal){return open(request,false,signal)},
    refresh(request,parent){
      const rejected=(error:unknown)=>{const operation=Promise.reject<LocalArtworkNavigationResult>(error);joins.set(operation,Promise.resolve());return operation}
      let resource:OriginalNavigationPhysical,url:URL
      try{
        if(closed)return fail('closed');if(active.size>=24)return fail('busy')
        if(!captureKey(request.originalCaptureKey))return fail('input')
        url=artworkWebUrl(request.source,request.query)
        const original=captures.get(request.originalCaptureKey)
        if(!original||!original.owned||original.source!==request.source||original.url!==url.href||original.hostIdentity!==request.hostIdentity)return fail('candidate')
        if(original.refreshing)return fail('busy')
        if(!currentCapture(original,request.originalCaptureKey,original.captureId))return fail('candidate')
        if(!originalRefresh||options.refresh!==originalRefresh)return fail('closed')
        resource=original
      }catch(error){return rejected(error)}
      const scope=deadline(parent,15_000),combined=AbortSignal.any([scope.signal,resource.signal]),controller=controllersForResource.get(resource)
      const cancel=()=>controller?.abort('provider-cancelled')
      scope.signal.addEventListener('abort',cancel,{once:true});if(scope.signal.aborted)cancel()
      resource.captureEpoch++;const epoch=resource.captureEpoch;resource.captureRevoked=true;resource.refreshing=true
      active.add(scope.controller)
      const originalReads=[...resource.reads]
      const producer=Promise.resolve().then(()=>{checkSignal(combined);return originalRefresh(url,{signal:combined,originalSignal:resource.signal,captureId:resource.captureId,...(resource.hostIdentity?{hostIdentity:resource.hostIdentity}:{})})})
      const operation=abortable(producer,combined).then(()=>{
        checkSignal(combined)
        if(closed||resource.ownedClosed||resource.captureEpoch!==epoch||captures.get(resource.originalCaptureKey!)!==resource)return fail('cancelled')
        resource.captureRevoked=false;return {opened:true as const}
      }).catch(error=>{resource.revokeCapture();cancel();throw safeProviderError(error,combined)}).finally(()=>scope.dispose())
      // refresh只登记本次实际reload/旧document读取。原navigate行继续持有同window.closed，不生成另一窗口生命周期。
      const physical=producer.then(()=>undefined,()=>undefined).then(async()=>{await Promise.allSettled(originalReads)})
        .finally(()=>{resource.refreshing=false;scope.dispose();scope.signal.removeEventListener('abort',cancel);active.delete(scope.controller);physicalTasks.delete(physical)})
      joins.set(operation,physical);if(controller)controllers.set(operation,controller);physicalTasks.add(physical)
      const cancelled=physical.then(async()=>{await resource.owned!.closed;await Promise.allSettled([...resource.reads])});cancelJoins.set(operation,cancelled);void cancelled.catch(()=>{physicalUnknown=true})
      void physical.catch(()=>{physicalUnknown=true});return operation
    },
    openExternal(request,signal){return open(request,true,signal)},
    async consumeCapturedImage(key,dragRef,signal){
      const reference=imageDragReference(dragRef)
      if(!(signal instanceof AbortSignal)||!captureKey(key)||!reference)return fail('candidate')
      checkSignal(signal)
      const resource=captures.get(key),id=reference.id
      if(!resource||!currentCapture(resource,key,id)||reference.sequence<=resource.lastConsumedSequence)return fail('candidate')
      if(resource.reads.size>=24)return fail('busy')
      // 同window可以继续新的可信drag；每个完整原引用先占一次，不保存URL或无界已消费集合。
      resource.lastConsumedSequence=reference.sequence
      const read=resource.owned?.readCapturedImage
      if(!read)return null
      const epoch=resource.captureEpoch
      const combined=AbortSignal.any([signal,resource.signal])
      const producer=Promise.resolve().then(()=>{checkSignal(combined);if(!currentCapture(resource,key,id)||resource.captureEpoch!==epoch||resource.lastConsumedSequence!==reference.sequence)return fail('candidate');return read(dragRef)})
      resource.reads.add(producer)
      void producer.then(()=>resource.reads.delete(producer),()=>resource.reads.delete(producer))
      try{
        const image=await abortable(producer,combined);checkSignal(combined)
        if(!currentCapture(resource,key,id)||resource.captureEpoch!==epoch||resource.lastConsumedSequence!==reference.sequence)return fail('candidate')
        if(image===null)return null
        if(!image||!Number.isFinite(image.ageMs)||image.ageMs<0||image.ageMs>30_000)return fail('candidate')
        return {url:checkedRemoteArtworkUrl(image.url).href,ageMs:image.ageMs}
      }catch(error){throw safeProviderError(error,combined)}
    },
    join(operation){return joins.get(operation)??Promise.reject(new Error('原导航producer身份未知。'))},
    cancelOriginal(operation){const physical=joins.get(operation);if(!physical)return Promise.reject(new Error('原导航producer身份未知。'));controllers.get(operation)?.abort('provider-cancelled');return cancelJoins.get(operation)??physical},
    close(){if(!closure){closed=true;for(const controller of active)controller.abort('provider-cancelled');closure=(async()=>{const results=await Promise.allSettled([...physicalTasks]);if(results.some(r=>r.status==='rejected'))return fail('closed');closureDone=true})();void closure.catch(()=>{physicalUnknown=true})}return closure},
  }
  navigationBrands.add(navigation);return navigation
}
