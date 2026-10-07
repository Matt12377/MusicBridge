import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCompatibilityAdmission, assertCompatibilityScope, assertCompatibilityLegacyInputs, COMPATIBILITY_LEGACY_INPUTS, COMPATIBILITY_PRELOAD_EXTENSION, COMPATIBILITY_REGRESSION_TESTS, COMPATIBILITY_TASK_SPEC, compatibilityStageSucceeded, runCompatibilityGate } from '../verify-mbrs014-compatibility.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = p => readFileSync(path.join(root, p));
function original() {
  return { scope: JSON.parse(read('docs/postrust/MBRS-014/EXECUTION_SCOPE.json')), task: read(COMPATIBILITY_TASK_SPEC.path),
    board: read('docs/postrust/MBRS-000/PACK_TASKBOARD.json'), acceptance: read('docs/postrust/MBRS-000/PACK_ACCEPTANCE.json'),
    g0: JSON.parse(read('docs/postrust/RUST-016/ADMISSION_DECISION.json')) };
}
const admit = v => assertCompatibilityAdmission(v.scope, v.task, v.board, v.acceptance, v.g0);
test('014固定49个旧验证输入，原schema30非空夹具不能改写', () => {
  const inputs = assertCompatibilityLegacyInputs(read(COMPATIBILITY_LEGACY_INPUTS.path), read);
  assert.equal(inputs.length, 49);
  assert.equal(inputs.some(input => input.path.endsWith('schema30-nonempty-legacy.sqlite')), true);
  assert.equal(inputs.some(input => input.path.endsWith('recording-source-candidate-ui.test.ts')), true);
});
test('014 Preload预期只准尾部新增六个公开方法，任何原断言或loader改变仍拒绝', () => {
  const methodNames = ['readLocalLegacyLinks', 'historyLocalLegacyLinks', 'previewLocalLegacyLink', 'confirmLocalLegacyLink', 'revokeLocalLegacyLink', 'undoLocalLegacyLink'];
  const base = read(COMPATIBILITY_PRELOAD_EXTENSION.path).toString('utf8');
  const marker = "    'onRemoteCoreEvent',\n  ])";
  const proposed = base.includes("    'readLocalLegacyLinks',") ? Buffer.from(base)
    : Buffer.from(base.replace(marker, "    'onRemoteCoreEvent',\n" + methodNames.map(name => "    '" + name + "',\n").join('') + '  ])'));
  const manifest = read(COMPATIBILITY_LEGACY_INPUTS.path);
  assert.equal(assertCompatibilityLegacyInputs(manifest, file => file === COMPATIBILITY_PRELOAD_EXTENSION.path ? proposed : read(file)).length, 49);
  const weakened = Buffer.from(proposed.toString('utf8').replace('assert.equal(Object.isFrozen(api), true)', 'assert.equal(true, true)'));
  assert.notDeepEqual(weakened, proposed);
  assert.throws(() => assertCompatibilityLegacyInputs(manifest, file => file === COMPATIBILITY_PRELOAD_EXTENSION.path ? weakened : read(file)));
});
test('014拒绝旧验证清单与任一旧断言的字节变更', () => {
  const bytes = read(COMPATIBILITY_LEGACY_INPUTS.path);
  assert.throws(() => assertCompatibilityLegacyInputs(Buffer.concat([bytes, Buffer.from(' ')]), read));
  const first = JSON.parse(bytes).files[0].path;
  assert.throws(() => assertCompatibilityLegacyInputs(bytes, file => file === first ? Buffer.concat([read(file), Buffer.from(' ')]) : read(file)));
});
function inventory() {
  const own = ['packages/contracts/test/mbrs014/contract.test.ts', 'packages/bridge-core/test/mbrs014/store.test.ts', 'apps/desktop/test/mbrs014-session.test.ts'];
  const all = [...COMPATIBILITY_REGRESSION_TESTS, ...own];
  const groups = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'].map((directory, index) => ({
    name: 'group-' + index, directory, expectedTests: 1, tests: all.filter(p => p.startsWith(directory + '/')).map(p => p.slice(directory.length + 1)),
  }));
  return { scope: { schema: 'mbrs014.compatibility-scope.v1', baseSha: 'b33357c09e6bded2b4c6c5acfcf7330e68366a5f',
    implementationComplete: true, countsConfirmed: true, sourceFilesWrite: 'OFF', groups }, own };
}
test('014原规格与18任务156AT保持，硬依赖只有002和009，现G0唯一Node作者准入', () => {
  const cases = admit(original()); assert.equal(cases.length, 8);
  assert.deepEqual(cases.map(c => c.id), Array.from({ length: 8 }, (_, i) => 'MBRS-AT-014-0' + (i + 1)));
  assert.equal(COMPATIBILITY_TASK_SPEC.bytes, 3652);
});
for (const [name, mutate] of [
  ['源写开关', v => { v.scope.sourceFilesWrite = 'ON'; }],
  ['Rust作者', v => { v.scope.defaultCore = 'Rust'; }],
  ['额外硬依赖', v => { v.scope.scheduling.hardDependencies.push('MBRS-011'); }],
  ['原任务字节', v => { v.task = Buffer.concat([v.task, Buffer.from(' ')]) }],
  ['原台账', v => { v.board = Buffer.concat([v.board, Buffer.from(' ')]) }],
  ['014AT缩减', v => { v.scope.taskAcceptanceCount = 6; }],
  ['取消后有效任务数量', v => { v.scope.effectiveTaskCount = 18; }],
  ['取消后有效验收数量', v => { v.scope.effectiveAcceptanceCount = 156; }],
  ['库版本漂移', v => { v.scope.catalogSchema = 35; }],
  ['前驱原件', v => { v.scope.predecessorFinalSeal.sha256 = 'a'.repeat(64); }],
  ['合成G0', v => { v.g0.is_synthetic = true; }],
  ['准入退出项', v => { v.g0.exit_items[0].status = 'OPEN'; }],
  ['双作者', v => { v.g0.component_owners.push({ ...v.g0.component_owners[0] }); }],
]) test('014入口拒绝' + name, () => { const value = original(); mutate(value); assert.throws(() => admit(value)); });
test('014测试清单完整匹配新增文件并保留必要回归，不能删改重复替换', () => {
  const { scope, own } = inventory(); assert.equal(assertCompatibilityScope(scope, own).length, 3);
  const nested = inventory();
  nested.own[2] = 'apps/desktop/test/mbrs014/session.test.ts';
  const nestedGroup = nested.scope.groups.find(group => group.directory === 'apps/desktop');
  nestedGroup.tests[nestedGroup.tests.indexOf('test/mbrs014-session.test.ts')] = 'test/mbrs014/session.test.ts';
  assert.equal(assertCompatibilityScope(nested.scope, nested.own).length, 3);
  assert.throws(() => assertCompatibilityScope(nested.scope, [...nested.own, 'apps/desktop/test/mbrs014/extra.test.ts']));
  for (const found of [own.slice(1), [...own, own[0]], [...own, 'apps/desktop/test/mbrs014-extra.test.ts']])
    assert.throws(() => assertCompatibilityScope(scope, found));
  for (const mutate of [
    s => { s.groups[0].tests.shift(); },
    s => { s.groups[0].tests.push('../outside.test.ts'); },
    s => { s.groups[0].expectedTests = 0; },
    s => { s.sourceFilesWrite = 'ON'; },
    s => { s.countsConfirmed = false; },
  ]) { const value = inventory(); mutate(value.scope); assert.throws(() => assertCompatibilityScope(value.scope, value.own)); }
});
test('014退出0必须伴随完整close、无信号与完整无skip的TAP', () => {
  const good = { exitCode: 0, signal: null, closeObserved: true, timedOut: false, overflow: false, captureFailed: false,
    preparationFailed: false, groupTerminationFailed: false, expectedTests: 2, tapStatusesClean: true,
    testCounts: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 } };
  assert.equal(compatibilityStageSucceeded(good), true);
  for (const value of [
    { exitCode: 1 }, { signal: 'SIGTERM' }, { closeObserved: false }, { timedOut: true }, { overflow: true },
    { captureFailed: true }, { preparationFailed: true }, { groupTerminationFailed: true }, { timedOut: undefined },
    { tapStatusesClean: false }, { testCounts: null }, { expectedTests: 3 },
    ...['fail', 'cancelled', 'skipped', 'todo'].map(key => ({ testCounts: { ...good.testCounts, [key]: 1 } })),
  ]) assert.equal(compatibilityStageSucceeded({ ...good, ...value }), false);
});
test('014错误CLI在输入读取、创建run与启动编译器前拒绝，无更换清单/计数入口', async t => {
  assert.equal(typeof process.env.TMPDIR, 'string');
  const parent = mkdtempSync(path.join(process.env.TMPDIR, 'musicbridge-compatibility-gate-cli-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'future');
  for (const args of [[], ['--unknown'], [`--output-root=${output}`, '--expected-tests=1'],
    [`--output-root=${output}`, '--live'], ['--output-root=']]) {
    await assert.rejects(runCompatibilityGate(args)); assert.equal(existsSync(output), false);
  }
});
