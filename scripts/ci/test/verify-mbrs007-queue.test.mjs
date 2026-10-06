import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMbQueueScope, MB_QUEUE_REGRESSION_TESTS } from '../verify-mbrs007-queue.mjs';

// 准入fixture只验证门禁行为，数量不能作为产品TAP证据。
const valid = () => ({ schema:'mbrs007.queue-scope.v1', baseSha:'b464dd2066346121a26824da516969b726f0cfe0',
  implementationComplete:true, countsConfirmed:true, groups:[
    {name:'core-mb-queue',directory:'packages/bridge-core',expectedTests:1,tests:['test/mbrs007/queue-controller.test.ts']},
    ...['packages/bridge-core','packages/contracts','apps/desktop'].map((directory,index)=>({name:'regression-'+index,directory,expectedTests:1,
      tests:MB_QUEUE_REGRESSION_TESTS.filter(path=>path.startsWith(directory+'/')).map(path=>path.slice(directory.length+1))}))
  ]});
const inventory = ['packages/bridge-core/test/mbrs007/queue-controller.test.ts'];
function rejects(edit,code){const scope=valid();edit(scope);assert.throws(()=>assertMbQueueScope(scope,inventory),error=>error.code===code);}
test('007 Gate：原队列、旧本地FD、迁移恢复及消费者回归一起准入',()=>assert.equal(assertMbQueueScope(valid(),inventory).length,4));
test('007 Gate：未完成实现或实际计数未冻结时拒绝',()=>{for(const key of ['implementationComplete','countsConfirmed'])rejects(scope=>{scope[key]=false;},'MB_QUEUE_SCOPE_NOT_FROZEN');});
test('007 Gate：不是006最终报告基线时拒绝',()=>rejects(scope=>{scope.baseSha='a'.repeat(40);},'MB_QUEUE_SCOPE_NOT_FROZEN'));
test('007 Gate：零负数或非整数计数拒绝',()=>{for(const count of [0,-1,0.5])rejects(scope=>{scope.groups[0].expectedTests=count;},'MB_QUEUE_GROUP_INVALID');});
test('007 Gate：漏列新测试或重复执行同文件拒绝',()=>{assert.throws(()=>assertMbQueueScope(valid(),[...inventory,'packages/bridge-core/test/mbrs007/new.test.ts']),error=>error.code==='MB_QUEUE_TEST_INVENTORY_MISMATCH');rejects(scope=>{scope.groups[0].tests.push(scope.groups[0].tests[0]);},'MB_QUEUE_TEST_INVENTORY_MISMATCH');});
test('007 Gate：漏掉关键旧FD、schema恢复或云调度回归拒绝',()=>{for(const path of ['packages/bridge-core/test/local-file-gateway.test.ts','packages/bridge-core/test/restore-dataset-runtime.test.ts','packages/bridge-core/test/netease-playback-scheduling.test.ts','packages/contracts/test/mbrs002/local-domain-references.test.ts','apps/desktop/test/playbackFavorites.test.ts'])rejects(scope=>{for(const group of scope.groups)group.tests=group.tests.filter(name=>group.directory+'/'+name!==path);},'MB_QUEUE_REQUIRED_REGRESSION_MISSING');rejects(scope=>{scope.groups.pop();},'MB_QUEUE_REQUIRED_REGRESSION_MISSING');});
test('007 Gate：越界、任意测试、旧任务伪装及重复组名拒绝',()=>{for(const path of ['../secret.test.ts','test/mbrs007/../bad.test.ts','/test/mbrs007/a.test.ts','test/mbrs005/unapproved.test.ts','test/arbitrary.test.ts'])rejects(scope=>{scope.groups[0].tests[0]=path;},'MB_QUEUE_TEST_PATH_INVALID');rejects(scope=>{scope.groups[0].directory='native/rust-core';},'MB_QUEUE_GROUP_INVALID');rejects(scope=>{scope.groups[1].name=scope.groups[0].name;},'MB_QUEUE_GROUP_INVALID');});
