import {Worker} from 'node:worker_threads';
import {withCheckedReadonlyMetadataSource,MetadataLeaseReleaseError,SourceFileError,type RootCapability} from '../recording/source-files.js';
export type CueSidecarReadResult={status:'ok';bytes:Uint8Array;readCalls:number}|{status:'failure';code:string};
export interface CueSidecarLifecycle {type:'worker-start'|'worker-exit'|'lease-acquired'|'lease-released';fd:number;threadId?:number}
export interface CueSidecarReaderInput {root:RootCapability;relative:string;expectedSignature:string;assertCurrent?():void}
const failure=(code:string):CueSidecarReadResult=>({status:'failure',code});
/** parent唯一拥有只读FD；取消、超时与close均等待真实worker exit及lease close。 */
export function createCueSidecarReader(options:{onLifecycle?:(event:CueSidecarLifecycle)=>void}={}) {
  let closed=false,fatal=false,closePromise:Promise<void>|undefined;
  const active=new Map<AbortController,Promise<CueSidecarReadResult>>();
  const emit=(event:CueSidecarLifecycle)=>{try{options.onLifecycle?.(event);}catch{/* 观察者不影响收口。 */}};
  function worker(fd:number,size:number,signal:AbortSignal):Promise<CueSidecarReadResult> {
    return new Promise(resolve=>{
      let actual:Worker;try{actual=new Worker(new URL('./cue-sidecar-worker.js',import.meta.url),{workerData:{fd,size},execArgv:[],env:{},resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:8,stackSizeMb:2}});}catch{resolve(failure('WORKER_FAILED'));return;}
      const threadId=actual.threadId;let forced:string|undefined,result:CueSidecarReadResult|undefined;
      const stop=(code:string)=>{forced ??= code;void actual.terminate().catch(()=>{forced='WORKER_FAILED';});};
      let readTimer:ReturnType<typeof setTimeout>|undefined;
      const startTimer=setTimeout(()=>stop('WORKER_START_TIMEOUT'),3000),abort=()=>stop('CANCELLED');
      signal.addEventListener('abort',abort,{once:true});
      actual.once('online',()=>{clearTimeout(startTimer);readTimer=setTimeout(()=>stop('TIMEOUT'),5000);if(signal.aborted) abort();});
      actual.on('message',(v:unknown)=>{
        if(result){stop('WORKER_FAILED');return;}
        if(typeof v !== 'object' || v === null){stop('WORKER_FAILED');return;}
        const value=v as Record<string,unknown>;
        if(value.status === 'ok' && value.bytes instanceof Uint8Array && value.bytes.length===size && size<=65536
          && typeof value.readCalls === 'number' && Number.isSafeInteger(value.readCalls) && value.readCalls>=1 && value.readCalls<=64) result={status:'ok',bytes:value.bytes,readCalls:value.readCalls};
        else if(value.status === 'failure' && ['BUDGET_EXCEEDED','IO_ERROR'].includes(String(value.code))) result=failure(String(value.code));
        else stop('WORKER_FAILED');
      });
      actual.once('error',()=>{forced ??='WORKER_FAILED';});
      actual.once('exit',code=>{clearTimeout(startTimer);clearTimeout(readTimer);signal.removeEventListener('abort',abort);emit({type:'worker-exit',fd,threadId});resolve(forced ? failure(forced):code===0 && result ? result:failure('WORKER_FAILED'));});
      emit({type:'worker-start',fd,threadId});if(signal.aborted) abort();
    });
  }
  return {
    read(input:CueSidecarReaderInput,signal?:AbortSignal):Promise<CueSidecarReadResult> {
      if(fatal) return Promise.resolve(failure('LEASE_RELEASE_FAILED'));
      if(closed) return Promise.resolve(failure('CLOSED'));
      if(active.size>=1) return Promise.resolve(failure('QUEUE_FULL'));
      if(signal?.aborted) return Promise.resolve(failure('CANCELLED'));
      const controller=new AbortController(),forward=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',forward,{once:true});
      const promise=(async()=>{
        try{return await withCheckedReadonlyMetadataSource(input.root,input.relative,input.expectedSignature,controller.signal,
          (handle,size)=>size>65536 ? Promise.resolve(failure('BUDGET_EXCEEDED')):worker(handle.fd,size,controller.signal),input.assertCurrent,emit);}
        catch(error){if(error instanceof MetadataLeaseReleaseError){fatal=true;return failure('LEASE_RELEASE_FAILED');}
          return failure(error instanceof SourceFileError ? error.code:controller.signal.aborted ? 'CANCELLED':'IO_ERROR');}
        finally{signal?.removeEventListener('abort',forward);active.delete(controller);}
      })();active.set(controller,promise);return promise;
    },
    close():Promise<void> {if(!closePromise){closed=true;const pending=[...active.entries()];for(const [controller] of pending) controller.abort();closePromise=Promise.all(pending.map(([,p])=>p)).then(()=>{if(fatal) throw new MetadataLeaseReleaseError();});}return closePromise;},
  };
}
export type CueSidecarReader=ReturnType<typeof createCueSidecarReader>;
