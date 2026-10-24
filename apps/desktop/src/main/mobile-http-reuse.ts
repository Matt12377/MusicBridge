import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export class MobileHttpSocketGateError extends Error {
  constructor() { super('原HTTP连接尚未安全收口。'); this.name = 'MobileHttpSocketGateError' }
}
interface Entry {
  resolve(): void; reject(error: Error): void; started: boolean; settled: boolean;
  signal: AbortSignal; abort(): void;
}
interface State { queue: Entry[]; failed: boolean; close(): void }
/** 只持当前socket的有限请求；前响应CL字节已送达也不等同于Owner已release。 */
export function createMobileHttpSocketGate() {
  const states = new WeakMap<Duplex,State>()
  return {
    enter(socket: Duplex, signal: AbortSignal) {
      if (signal.aborted || socket.destroyed) throw new MobileHttpSocketGateError()
      let state=states.get(socket)
      if(!state){
        const next:State={queue:[],failed:false,close(){
          next.failed=true
          for(const item of next.queue.splice(0)){
            item.signal.removeEventListener('abort',item.abort)
            if(!item.started)item.reject(new MobileHttpSocketGateError())
          }
          states.delete(socket)
        }}
        state=next;states.set(socket,state);socket.once('close',state.close)
      }
      if(state.failed||state.queue.length>=16)throw new MobileHttpSocketGateError()
      const own=state
      let resolve!:()=>void,reject!:(error:Error)=>void
      const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no})
      const entry:Entry={resolve,reject,started:false,settled:false,signal,abort(){
        if(entry.started||entry.settled)return
        entry.settled=true
        const i=own.queue.indexOf(entry)
        if(i>=0)own.queue.splice(i,1)
        signal.removeEventListener('abort',entry.abort)
        reject(new MobileHttpSocketGateError())
      }}
      own.queue.push(entry);signal.addEventListener('abort',entry.abort,{once:true})
      if(own.queue.length===1){entry.started=true;resolve()}
      if(signal.aborted)entry.abort()
      return {ready,finish(success:boolean){
        if(entry.settled)return;entry.settled=true
        signal.removeEventListener('abort',entry.abort)
        const i=own.queue.indexOf(entry)
        if(i<0)return
        own.queue.splice(i,1)
        if(!success){
          own.failed=true
          for(const waiting of own.queue.splice(0)){
            waiting.signal.removeEventListener('abort',waiting.abort)
            waiting.reject(new MobileHttpSocketGateError())
          }
        }else if(i===0&&own.queue[0]){
          own.queue[0].started=true;own.queue[0].resolve()
        }
        if(!own.queue.length&&!own.failed){socket.removeListener('close',own.close);states.delete(socket)}
      }}
    },
  }
}
/** 只有原readBody成功到end后，Main才可把bodyConsumed设true；未知默认关闭。 */
export function canReuseMobileHttp(request: IncomingMessage, bodyConsumed: boolean, signal: AbortSignal): boolean {
  return bodyConsumed && request.complete===true && request.readableEnded===true && !request.aborted && !signal.aborted
}
/** 不强写keep-alive，让Node保留客户端close和第16次的决定。 */
export function mobileHttpConnectionHeaders(response: {shouldKeepAlive:boolean}, status:number, verified:boolean): string[] {
  if(verified&&status>=200&&status<300)return []
  response.shouldKeepAlive=false
  return ['Connection','close']
}
