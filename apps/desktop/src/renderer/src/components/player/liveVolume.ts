interface LiveVolumeOptions {
 initial:number;step:number;now:()=>number
 schedule:(callback:()=>void,delay:number)=>number;cancel:(timer:number)=>void
 send:(value:number)=>Promise<unknown>;show:(value:number)=>void;error:()=>void
}
/** 拖动值立即显示；80ms 内合并，只保留最新目标，最多一个设备请求在途。 */
export function createLiveVolume(options:LiveVolumeOptions) {
 let observed=options.initial, draft:number|undefined, queued:number|undefined
 let inflight:number|undefined, timer:number|undefined, expected:number|undefined
 let editing=false, disposed=false, sentAt=-Infinity, deadline=Infinity
 const equal=(a:number,b:number)=>Math.abs(a-b)<Math.max(.00001,options.step/2)
 function pump(){
  if(disposed || inflight!==undefined || queued===undefined || timer!==undefined)return
  const delay=80-(options.now()-sentAt)
  if(delay>0){timer=options.schedule(()=>{timer=undefined;pump()},delay);return}
  const value=queued;queued=undefined;inflight=value;sentAt=options.now()
  void options.send(value).then(()=>{
   if(disposed)return
   expected=value;deadline=options.now()+8000
  },()=>{
   if(disposed)return
   if(queued===undefined){draft=undefined;expected=undefined;options.show(observed);options.error()}
  }).finally(()=>{
   inflight=undefined
   if(!disposed)pump()
  })
 }
 return {
  input(value:number){
   if(disposed || !Number.isFinite(value))return
   editing=true;draft=value;options.show(value)
   if(inflight!==undefined && equal(inflight,value)){queued=undefined;return}
   if(inflight===undefined && expected!==undefined && equal(expected,value)){queued=undefined;return}
   queued=value;pump()
  },
  commit(){editing=false;pump()},
  observe(value:number){
   if(disposed || !Number.isFinite(value))return
   observed=value
   if(draft!==undefined){
    if(editing || queued!==undefined || inflight!==undefined)return
    if(expected!==undefined && equal(value,expected)){draft=undefined;expected=undefined}
    else if(options.now()>deadline){draft=undefined;expected=undefined;options.error()}
    else return
   }
   options.show(value)
  },
  dispose(){disposed=true;queued=undefined;if(timer!==undefined)options.cancel(timer)},
 }
}
