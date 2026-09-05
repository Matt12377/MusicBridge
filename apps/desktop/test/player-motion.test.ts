import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlaybackClock } from '../src/renderer/src/components/player/playbackClock.js'
import { createLiveVolume } from '../src/renderer/src/components/player/liveVolume.js'
const sample=(position:number,state='playing',id='a')=>({id,state,position,duration:180000})
test('重复和整数秒快照不会把进度拉回，连续帧保持向前',()=>{
 const c=createPlaybackClock();c.observe(sample(10000),0)
 assert.equal(c.read(800),10800)
 c.observe(sample(10000),800)
 assert.equal(c.read(900),10900)
 c.observe(sample(11000),1300)
 let previous=c.read(1300)
 for(let t=1316;t<2300;t+=16){const current=c.read(t);assert.ok(current>=previous);assert.ok(current-previous<25);previous=current}
})
test('拖动不受后台快照干扰，失败回到观测，切歌废弃旧确认',()=>{
 const c=createPlaybackClock();c.observe(sample(10000),0)
 const seek=c.preview(65000,100)
 c.observe(sample(11000),200);assert.equal(c.read(250),65000)
 c.settle(seek,65000,300);c.observe(sample(11000),400);assert.ok(c.read(500)>=65000)
 c.observe(sample(0,'playing','b'),600);c.settle(seek,65000,700);assert.ok(c.read(700)<1000)
 const failed=c.preview(40000,800);c.settle(failed,undefined,900);assert.ok(c.read(900)<1000)
 c.observe(sample(3000,'paused','b'),1000);assert.equal(c.read(6000),3000)
})
function harness(){
 let now=0;let next=0;const timers=new Map<number,{at:number;fn:()=>void}>();const calls:{value:number;resolve:()=>void;reject:()=>void}[]=[];let shown=40;let errors=0
 const c=createLiveVolume({initial:40,step:1,now:()=>now,schedule:(fn,ms)=>{const id=++next;timers.set(id,{at:now+ms,fn});return id},cancel:id=>{timers.delete(id)},send:value=>new Promise<void>((resolve,reject)=>calls.push({value,resolve,reject:()=>reject(Error('设备失败'))})),show:value=>{shown=value},error:()=>{errors++}})
 const advance=(ms:number)=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}}
 return {c,calls,advance,shown:()=>shown,errors:()=>errors}
}
const flush=async()=>{await Promise.resolve();await Promise.resolve()}
test('按住音量时实时发送、串行合并中间值，松手不回闪',async()=>{
 const h=harness();h.c.input(41);assert.equal(h.calls[0]?.value,41)
 h.c.input(42);h.c.input(45);assert.equal(h.shown(),45);assert.equal(h.calls.length,1)
 h.c.observe(40);assert.equal(h.shown(),45)
 h.calls[0]!.resolve();await flush();h.advance(80);assert.equal(h.calls[1]?.value,45)
 h.c.commit();h.calls[1]!.resolve();await flush();h.c.observe(41);assert.equal(h.shown(),45)
 h.c.observe(45);assert.equal(h.shown(),45);h.c.observe(46);assert.equal(h.shown(),46)
})
test('音量失败回退且提示；未确认超时不会永久伪装成功；切设备取消队列',async()=>{
 const h=harness();h.c.input(50);h.c.commit();h.calls[0]!.reject();await flush();assert.equal(h.shown(),40);assert.equal(h.errors(),1)
 h.c.input(55);h.advance(80);h.c.commit();h.calls[1]!.resolve();await flush();h.advance(8001);h.c.observe(40);assert.equal(h.shown(),40);assert.equal(h.errors(),2)
 h.c.input(60);h.advance(80);h.c.input(70);h.c.dispose();h.calls[2]!.resolve();await flush();h.advance(80);assert.equal(h.calls.length,3)
})
