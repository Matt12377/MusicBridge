import test from 'node:test';
import assert from 'node:assert/strict';
import { coreTestPhases, runCoreTestPhases, runPreparedCoreTests, createPreparationClock } from '../run-core-tests.mjs';

const isolated = 'recording-capacity-queued-stop.test.ts';
const phases = () => coreTestPhases(['b.test.ts', isolated, 'a.test.ts', 'helpers', 'README.md']);

test('Core 阶段保留全部原测试且恰好执行一次，排队 Stop 独立运行', () => {
  const result = phases();
  const files = result.flatMap(phase => phase.args.filter(arg => arg.startsWith('test/')));
  assert.deepEqual(files, ['test/a.test.ts', 'test/b.test.ts', `test/${isolated}`]);
  assert.equal(new Set(files).size, 3);
  assert.equal(result[0].args.some(arg => arg.startsWith('--test-concurrency')), false);
  assert.ok(result[1].args.includes('--test-concurrency=1'));
  assert.equal(result.some(phase => phase.args.some(arg => /pattern|skip/u.test(arg))), false);
});
test('缺失或重复排队 Stop 时明确失败，不默默减少清单', () => {
  for (const names of [[], ['a.test.ts'], [isolated, isolated, 'a.test.ts']]) {
    assert.throws(() => coreTestPhases(names), /清单不完整/u);
  }
});
test('原 Core 阶段失败时保留退出码并停止后续阶段', () => {
  let calls = 0;
  assert.equal(runCoreTestPhases(phases(), () => { calls += 1; return { status: 7 }; }, () => {}), 7);
  assert.equal(calls, 1);
});
test('排队 Stop 阶段失败不会被前一阶段成功覆盖', () => {
  const results = [{ status: 0 }, { status: 9 }];
  assert.equal(runCoreTestPhases(phases(), () => results.shift(), () => {}), 9);
  assert.equal(results.length, 0);
});
test('子进程启动错误或非自然结束不能成为成功', () => {
  for (const result of [{ status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('启动失败') }, { status: null }]) {
    assert.equal(runCoreTestPhases(phases(), () => result, () => {}), 1);
  }
  assert.equal(runCoreTestPhases(phases(), () => ({ status: 0 }), () => {}), 0);
});


test('标准Core入口等待本次Reader准备，外部旧声明不跳过准备且两阶段共享childEnv', async () => {
  let release;const gate=new Promise(resolve=>{release=resolve;}),events=[],env={MBRS003_READER_BUILD_BINDING:'/synthetic/old-forged.json'};
  const childEnv={...env,MBRS003_READER_BUILD_BINDING:'/synthetic/current-private/reader-build-binding.json'};
  const work=runPreparedCoreTests(['a.test.ts',isolated],{
    env,announce:()=>{},prepare:async options=>{events.push('prepare-start');assert.equal(options.env,env);await gate;events.push('prepare-done');return {env:childEnv,assertCurrent:()=>events.push('current')};},
    execute:(_command,args,options)=>{assert.equal(options.env,childEnv);assert.equal(Object.hasOwn(options,'timeout'),false);assert.equal(Object.hasOwn(options,'killSignal'),false);events.push(args.at(-1));return {status:0};},
  });
  await Promise.resolve();assert.deepEqual(events,['prepare-start']);release();assert.equal(await work,0);
  assert.ok(events.indexOf('prepare-done')<events.indexOf('test/a.test.ts'));assert.equal(events.filter(x=>x==='test/a.test.ts').length,1);assert.equal(events.filter(x=>x===`test/${isolated}`).length,1);
  assert.equal(env.MBRS003_READER_BUILD_BINDING,'/synthetic/old-forged.json');
});
test('标准Core入口准备失败禁止任何测试阶段，保留准备异常', async () => {
  let dispatched=0;const error=new Error('本次fixedWorker准备失败');
  await assert.rejects(runPreparedCoreTests(['a.test.ts',isolated],{prepare:async()=>{throw error;},execute:()=>{dispatched++;return {status:0};},announce:()=>{}}),value=>value===error);
  assert.equal(dispatched,0);
});
test('标准Core入口缺声明或缺最终身份核验均零测试派发', async () => {
  for(const prepared of [{env:{},assertCurrent(){}},{env:{MBRS003_READER_BUILD_BINDING:'relative.json'},assertCurrent(){}},{env:{MBRS003_READER_BUILD_BINDING:'/synthetic/reader.json'}}]){
    let dispatched=0;await assert.rejects(runPreparedCoreTests(['a.test.ts',isolated],{prepare:async()=>prepared,execute:()=>{dispatched++;return {status:0};},announce:()=>{}}),/准备未完成/u);assert.equal(dispatched,0);
  }
});
test('标准Core入口声明准备后输入漂移不能派发第一测试阶段', async () => {
  let dispatched=0;await assert.rejects(runPreparedCoreTests(['a.test.ts',isolated],{prepare:async()=>({env:{MBRS003_READER_BUILD_BINDING:'/synthetic/reader.json'},assertCurrent(){throw new Error('冻结输入漂移');}}),execute:()=>{dispatched++;return {status:0};},announce:()=>{}}),/输入漂移/u);assert.equal(dispatched,0);
});
test('第一Core阶段成功后产物漂移禁止独立Stop阶段，不能用前阶段PASS覆盖', async () => {
  let checks=0,dispatched=0;await assert.rejects(runPreparedCoreTests(['a.test.ts',isolated],{prepare:async()=>({env:{MBRS003_READER_BUILD_BINDING:'/synthetic/reader.json'},assertCurrent(){if(++checks===3)throw new Error('产物漂移');}}),execute:()=>{dispatched++;return {status:0};},announce:()=>{}}),/产物漂移/u);assert.equal(dispatched,1);
});

test('准备封存后身份核验不因旧准备时钟耗尽假失败，输入漂移仍必须失败', () => {
  let expired=false,sourceChanged=false,reads=0;
  const clock=createPreparationClock({check(){if(expired)throw new Error('准备预算耗尽');},timeout(){return 180_000;}});
  const verify=()=>{clock.check();reads++;if(sourceChanged)throw new Error('输入身份漂移');};
  verify();assert.equal(clock.timeout(),180_000);clock.finish();expired=true;
  verify();assert.equal(reads,2);sourceChanged=true;assert.throws(verify,/身份漂移/u);
  assert.throws(()=>clock.timeout(),/不能重新派发构建/u);
});
