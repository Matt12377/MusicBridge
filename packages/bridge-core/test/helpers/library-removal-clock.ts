import type { TestContext } from 'node:test'

/** 同步推进真实生产代码使用的wall/单调时钟与timer；不把tick误当成performance.now。 */
export function libraryRemovalClock(t:TestContext) {
  let monotonic=Math.floor(performance.now()),active=true
  const observed=t.mock.method(performance,'now',()=>monotonic)
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()})
  function reset(){if(!active)return;active=false;t.mock.timers.reset();observed.mock.restore()}
  t.after(reset)
  return {advance(ms:number){monotonic+=ms;t.mock.timers.tick(ms)},elapse(ms:number){monotonic+=ms;t.mock.timers.setTime(Date.now()+ms)},rewind(ms:number){t.mock.timers.setTime(Date.now()-ms)},reset}
}
