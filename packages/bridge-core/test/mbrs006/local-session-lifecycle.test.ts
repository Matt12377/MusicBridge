import test from 'node:test';
import assert from 'node:assert/strict';
import {adapterFixture,syntheticPlayRequest,tick} from './adapter-fixture.js';
test('真实SessionEnded回报收口已Playing的本次会话，而非HTTP完成',async () => {
  const f = await adapterFixture(), terminals:string[]=[]; f.adapter.setTerminalHandler(reason=>terminals.push(reason));
  const work=f.adapter.play(syntheticPlayRequest); await tick(); f.sessions[0]!('SessionBegan',{session_id:'synthetic-session'}); await work;
  f.sessions[0]!('SessionEnded',{}); assert.deepEqual(terminals,['ended']); await f.adapter.shutdown();
});
