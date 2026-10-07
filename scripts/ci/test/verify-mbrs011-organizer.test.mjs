import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOrganizerAdmission, assertOrganizerScope, ORGANIZER_REGRESSION_TESTS, ORGANIZER_TASK_SPEC, organizerStageSucceeded, runOrganizerGate } from '../verify-mbrs011-organizer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = p => readFileSync(path.join(root, p));
function original() {
  return { scope: JSON.parse(read('docs/postrust/MBRS-011/EXECUTION_SCOPE.json')), task: read(ORGANIZER_TASK_SPEC.path),
    board: read('docs/postrust/MBRS-000/PACK_TASKBOARD.json'), acceptance: read('docs/postrust/MBRS-000/PACK_ACCEPTANCE.json'),
    g0: JSON.parse(read('docs/postrust/RUST-016/ADMISSION_DECISION.json')) };
}
const admit = v => assertOrganizerAdmission(v.scope, v.task, v.board, v.acceptance, v.g0);
function inventory() {
  const own = ['packages/contracts/test/mbrs011/contract.test.ts', 'packages/bridge-core/test/mbrs011/store.test.ts', 'apps/desktop/test/mbrs011-session.test.ts'];
  const all = [...ORGANIZER_REGRESSION_TESTS, ...own];
  const groups = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'].map((directory, index) => ({
    name: 'group-' + index, directory, expectedTests: 1, tests: all.filter(p => p.startsWith(directory + '/')).map(p => p.slice(directory.length + 1)),
  }));
  return { scope: { schema: 'mbrs011.organizer-scope.v1', baseSha: 'db4cded876e8eda7755d781ed4827dfc38332a10',
    implementationComplete: true, countsConfirmed: true, sourceFilesWrite: 'OFF', groups }, own };
}
test('011原规格与18任务156AT保持，硬依赖只有009，现G0唯一Node作者准入', () => {
  const cases = admit(original()); assert.equal(cases.length, 7);
  assert.deepEqual(cases.map(c => c.id), Array.from({ length: 7 }, (_, i) => 'MBRS-AT-011-0' + (i + 1)));
  assert.equal(ORGANIZER_TASK_SPEC.bytes, 3163);
});
for (const [name, mutate] of [
  ['源写开关', v => { v.scope.sourceFilesWrite = 'ON'; }],
  ['Rust作者', v => { v.scope.defaultCore = 'Rust'; }],
  ['额外010产品门槛', v => { v.scope.scheduling['010ProductCompletionRequired'] = true; }],
  ['原任务字节', v => { v.task = Buffer.concat([v.task, Buffer.from(' ')]) }],
  ['原台账', v => { v.board = Buffer.concat([v.board, Buffer.from(' ')]) }],
  ['011AT缩减', v => { v.scope.taskAcceptanceCount = 6; }],
  ['前驱原件', v => { v.scope.predecessorFinalSeal.sha256 = 'a'.repeat(64); }],
  ['合成G0', v => { v.g0.is_synthetic = true; }],
  ['准入退出项', v => { v.g0.exit_items[0].status = 'OPEN'; }],
  ['双作者', v => { v.g0.component_owners.push({ ...v.g0.component_owners[0] }); }],
]) test('011入口拒绝' + name, () => { const value = original(); mutate(value); assert.throws(() => admit(value)); });
test('011测试清单完整匹配新增文件并保留必要回归，不能删改重复替换', () => {
  const { scope, own } = inventory(); assert.equal(assertOrganizerScope(scope, own).length, 3);
  for (const found of [own.slice(1), [...own, own[0]], [...own, 'apps/desktop/test/mbrs011-extra.test.ts']])
    assert.throws(() => assertOrganizerScope(scope, found));
  for (const mutate of [
    s => { s.groups[0].tests.shift(); },
    s => { s.groups[0].tests.push('../outside.test.ts'); },
    s => { s.groups[0].expectedTests = 0; },
    s => { s.sourceFilesWrite = 'ON'; },
    s => { s.countsConfirmed = false; },
  ]) { const value = inventory(); mutate(value.scope); assert.throws(() => assertOrganizerScope(value.scope, value.own)); }
});
test('011退出0必须伴随完整close、无信号与完整无skip的TAP', () => {
  const good = { exitCode: 0, signal: null, closeObserved: true, timedOut: false, overflow: false, captureFailed: false,
    preparationFailed: false, groupTerminationFailed: false, expectedTests: 2, tapStatusesClean: true,
    testCounts: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 } };
  assert.equal(organizerStageSucceeded(good), true);
  for (const value of [
    { exitCode: 1 }, { signal: 'SIGTERM' }, { closeObserved: false }, { timedOut: true }, { overflow: true },
    { captureFailed: true }, { preparationFailed: true }, { groupTerminationFailed: true }, { timedOut: undefined },
    { tapStatusesClean: false }, { testCounts: null }, { expectedTests: 3 },
    ...['fail', 'cancelled', 'skipped', 'todo'].map(key => ({ testCounts: { ...good.testCounts, [key]: 1 } })),
  ]) assert.equal(organizerStageSucceeded({ ...good, ...value }), false);
});
test('011错误CLI在输入读取、创建run与启动编译器前拒绝，无更换清单/计数入口', async t => {
  assert.equal(typeof process.env.TMPDIR, 'string');
  const parent = mkdtempSync(path.join(process.env.TMPDIR, 'musicbridge-organizer-gate-cli-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'future');
  for (const args of [[], ['--unknown'], [`--output-root=${output}`, '--expected-tests=1'],
    [`--output-root=${output}`, '--live'], ['--output-root=']]) {
    await assert.rejects(runOrganizerGate(args)); assert.equal(existsSync(output), false);
  }
});
