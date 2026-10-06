import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMbQueueScope, MB_QUEUE_REGRESSION_TESTS, mbQueueTestStage } from '../verify-mbrs007-queue.mjs';
import { parseTestCounts, isCompleteTestRun } from '../verify-mbrs001-offline.mjs';

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

test('007 Gate：真实回归进程最多两个并行，环境、cwd、全局状态隔离且三文件完整执行', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-mbrs007-process-'));
  const cwd = path.resolve(fileURLToPath(new URL('../../../packages/bridge-core/', import.meta.url)));
  const marker = path.basename(directory), files = [];
  const fixture = `import test from 'node:test'; import assert from 'node:assert/strict';
import { writeFile, mkdir, access } from 'node:fs/promises'; import path from 'node:path';
const index = Number(path.basename(import.meta.url).split('-')[0]);
test('独立进程夹具', async () => {
  const root = process.env.MBRS007_PROBE_ROOT;
  assert.equal(process.cwd(), process.env.MBRS007_PROBE_CWD);
  assert.equal(process.env.MBRS007_PROBE_STATE, process.env.MBRS007_PROBE_BASE);
  assert.equal(globalThis.mbrs007Probe, undefined);
  const local = path.join(root, 'cwd-' + index); await mkdir(local);
  process.chdir(local); process.env.MBRS007_PROBE_STATE = String(index); globalThis.mbrs007Probe = index;
  await writeFile(path.join(root, index + '.started'), JSON.stringify({ index, pid: process.pid }));
  while (true) { try { await access(path.join(root, 'release')); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
  assert.equal(process.cwd(), local); assert.equal(process.env.MBRS007_PROBE_STATE, String(index));
  assert.equal(globalThis.mbrs007Probe, index);
});`;
  for (let i = 0; i < 3; i++) {
    const file = path.join(directory, `${i}-probe.test.mjs`); await writeFile(file, fixture); files.push(file);
  }
  for (const name of ['core-mb-queue', 'contracts-queue', 'desktop-queue']) {
    assert.equal(mbQueueTestStage({ name, directory: 'packages/bridge-core', tests: [] }).testConcurrency, 1);
  }
  assert.equal(mbQueueTestStage({ name: 'core-affected-regression', directory: 'apps/desktop', tests: [] }).testConcurrency, 1);
  const stage = mbQueueTestStage({ name: 'core-affected-regression', directory: 'packages/bridge-core', tests: files });
  const parentCwd = process.cwd(), parentState = process.env.MBRS007_PROBE_STATE;
  const env = { ...process.env, MBRS007_PROBE_ROOT: directory, MBRS007_PROBE_CWD: cwd,
    MBRS007_PROBE_BASE: marker, MBRS007_PROBE_STATE: marker };
  // 新runner须清除父node:test的内部上下文，避免被误判为递归测试。
  delete env.NODE_TEST_CONTEXT;
  let output = '', child, closed = false;
  const completed = new Promise((resolve, reject) => {
    child = spawn(process.execPath, stage.args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env });
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  const exists = file => access(path.join(directory, file)).then(() => true, () => false);
  const deadline = performance.now() + 10_000;
  try {
    while (!(await exists('0.started') && await exists('1.started'))) {
      assert.equal(closed, false, output);
      assert.ok(performance.now() < deadline, '两个进程须实际同时到达屏障；串行执行不能通过');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await exists('2.started'), false, '前两个进程占用并发槽时，第三个不能启动');
    await writeFile(path.join(directory, 'release'), '继续');
    const terminal = await Promise.race([completed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('受控测试进程未闭合')), 10_000); timer.unref();
    })]);
    assert.deepEqual(terminal, { code: 0, signal: null }, output);
    assert.ok(isCompleteTestRun(parseTestCounts(output), 3), output);
    const rows = await Promise.all([0, 1, 2].map(async i => JSON.parse(await readFile(path.join(directory, `${i}.started`), 'utf8'))));
    assert.equal(new Set(rows.map(row => row.pid)).size, 3);
    assert.ok(rows.every(row => row.pid !== process.pid));
    assert.equal(process.cwd(), parentCwd); assert.equal(process.env.MBRS007_PROBE_STATE, parentState);
    assert.equal(globalThis.mbrs007Probe, undefined);
  } finally {
    if (!closed && child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await completed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
