interface ClockSample { id: string; state: string; position: number; duration: number }
/** 快照是设备观测，显示时钟独立运行；小误差调速校准，明确跳转才重新定位。 */
export function createPlaybackClock() {
 let sample: ClockSample = {id:'',state:'idle',position:0,duration:0}
 let base=0, at=0, rate=1, revision=0
 let draft: number | undefined
 let protectUntil=0
 const bound=(value:number)=>Math.min(Math.max(0,sample.duration),Math.max(0,value))
 function read(now:number):number { return draft ?? bound(base+(sample.state==='playing' ? Math.max(0,now-at)*rate : 0)) }
 function anchor(value:number,now:number){base=bound(value);at=now;rate=1}
 return {
  read,
  observe(next:ClockSample,now:number) {
   const changed=next.id!==sample.id
   const stateChanged=next.state!==sample.state
   const duplicate=next.position===sample.position && !changed && !stateChanged
   const current=read(now)
   sample=next
   if(changed){revision++;draft=undefined;protectUntil=0;anchor(next.position,now);return}
   if(draft!==undefined || duplicate) return
   const difference=next.position-current
   if(now<protectUntil && Math.abs(difference)>1500) return
   if(stateChanged || Math.abs(difference)>3000){anchor(next.position,now);return}
   if(next.state==='playing') {
    base=current;at=now
    rate=1+Math.max(-.2,Math.min(.2,difference/4000))
   }
  },
  preview(value:number,_now:number):number {draft=bound(value);return ++revision},
  settle(token:number,value:number|undefined,now:number) {
   if(token!==revision)return
   draft=undefined
   anchor(value ?? sample.position,now)
   protectUntil=value===undefined ? 0 : now+2000
  },
  cancel(now:number){revision++;draft=undefined;anchor(sample.position,now)},
 }
}
