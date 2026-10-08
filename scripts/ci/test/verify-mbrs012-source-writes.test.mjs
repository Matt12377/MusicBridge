import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceWritesAdmission, assertSourceWritesScope, sourceWritesStageSucceeded,
  SOURCE_WRITES_TASK_SPEC, SOURCE_WRITES_LIMITS, SOURCE_WRITES_REGRESSION_TESTS } from '../verify-mbrs012-source-writes.mjs';
import { assertCompatibilityLegacyInputs, COMPATIBILITY_LEGACY_INPUTS,
  COMPATIBILITY_PRELOAD_EXTENSION, COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION } from '../verify-mbrs014-compatibility.mjs';
import { normalizeSealed012LegacyInput } from '../mbrs013-legacy-input-normalization.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = relative => normalizeSealed012LegacyInput(relative, readFileSync(path.join(repository, relative)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function admission() {
  return { scope: JSON.parse(read('docs/postrust/MBRS-012/EXECUTION_SCOPE.json')),
    task: read(SOURCE_WRITES_TASK_SPEC.path), board: read('docs/postrust/MBRS-000/PACK_TASKBOARD.json'),
    acceptance: read('docs/postrust/MBRS-000/PACK_ACCEPTANCE.json'),
    g0: JSON.parse(read('docs/postrust/RUST-016/ADMISSION_DECISION.json')) };
}
const admit = value => assertSourceWritesAdmission(value.scope, value.task, value.board, value.acceptance, value.g0);

test('012准入精确9原AT与18/156原始包，规则文件不冒充writer资格', () => {
  const value = admission(), cases = admit(value);
  assert.equal(cases.length, 9);
  assert.deepEqual(cases.map(row => row.id), Array.from({ length: 9 }, (_, i) => `MBRS-AT-012-0${i + 1}`));
  assert.equal(cases[8].kind, 'security');
  assert.equal(cases[8].introduced_in, '1.2');
  assert.equal(value.scope.libraryWriteEnabledDefault, false);
});

for (const [name, change] of [
  ['拒绝默认开启源写', value => { value.scope.libraryWriteEnabledDefault = true; }],
  ['拒绝旧011源写开启', value => { value.scope.legacyOrganizerSourceFiles = 'ON'; }],
  ['拒绝第二数据库作者', value => { value.g0.component_owners.push({ database_id: 'owned-dataset-sqlite', writer_id: 'another-writer', language: 'Node' }); }],
  ['拒绝Rust取得数据库', value => { value.g0.component_owners.push({ database_id: 'unexpected-database', writer_id: 'rust-writer', language: 'Rust' }); }],
  ['拒绝缺014硬依赖', value => { value.scope.scheduling.hardDependencies.splice(2, 1); }],
  ['拒绝伪造前置报告收据', value => { value.scope.predecessorFinalSeal.sha256 = '0'.repeat(64); }],
  ['拒绝原任务任一字节改变', value => { value.task = Buffer.concat([value.task, Buffer.from(' ')]); }],
  ['拒绝原验收包改kind', value => { const pack = JSON.parse(value.acceptance); pack.cases.find(row => row.id === 'MBRS-AT-012-09').kind = 'unit'; value.acceptance = Buffer.from(JSON.stringify(pack)); }],
  ['拒绝未经核定格式', value => { value.scope.writerFormatProfiles.push('ID3V23'); }],
  ['拒绝虚构原子发布能力', value => { value.scope.publisherProfile = 'ATOMIC_REPLACE'; }],
  ['拒绝扩大旧图片JSON额度', value => { value.scope.binaryOriginalTransport.oldArtworkJsonGuardUnchanged = false; }],
  ['拒绝改变旧Reader预算', value => { value.scope.writerIoLimits.oldReaderBudgetsUnchanged = false; }],
  ['拒绝漏计隔离原件', value => { value.scope.writerIoLimits.safetyStoreCounts.pop(); }],
  ['拒绝减去终态容量预留', value => { value.scope.writerIoLimits.prePublicationReservation = 'SOURCE_BYTES_ONLY'; }],
  ['拒绝UNKNOWN重新投递', value => { value.scope.unknownCommandReconciliation.notFoundAllowsRetry = true; }],
  ['拒绝把受理当实际写成', value => { value.scope.unknownCommandReconciliation.acceptedMeansSourceEffect = true; }],
  ['拒绝伪ScanJob', value => { value.scope.sourceFactProjection.syntheticScanJobAllowed = true; }],
  ['拒绝后继扫描双增revision', value => { value.scope.sourceFactProjection.followingScanDoubleRevisionAllowed = true; }],
  ['拒绝直接计划借用逆向合同', value => { value.scope.inverseProjection.directPlansMayUseRestoration = true; }],
  ['拒绝把旧备份封面冒称当前候选原件', value => { value.scope.inverseProjection.coverCandidateIdentityBorrowAllowed = true; }],
  ['拒绝丢弃原artist多值恢复', value => { value.scope.inverseProjection.originalArtistMultiValuesRestored = false; }],
]) test(`012${name}`, () => { const value = admission(); change(value); assert.throws(() => admit(value)); });

for (const [field, limits] of Object.entries({ binaryOriginalTransport: SOURCE_WRITES_LIMITS.binary,
  planLimits: SOURCE_WRITES_LIMITS.plan, writerIoLimits: SOURCE_WRITES_LIMITS.io })) {
  test(`012逐个拒绝${field}预算扩大或减少`, () => {
    for (const [key, original] of Object.entries(limits)) for (const delta of [-1, 1]) {
      const value = admission(); value.scope[field][key] = original + delta;
      assert.throws(() => admit(value), `${field}.${key}必须保持冻结值`);
    }
  });
}

test('012 Preload仅追加七名称，014全部原assertion/loader/context及48文件保持', () => {
  const actual = read(COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION.path);
  assert.equal(actual.length, COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION.bytes);
  assert.equal(sha(actual), COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION.sha256);
  const names = ['previewLocalSourceWrites', 'getLocalSourceWrites', 'listLocalSourceWritesHistory',
    'confirmLocalSourceWrites', 'undoLocalSourceWrites', 'cancelLocalSourceWrites', 'setLocalSourceWritesPolicy'];
  const addition = names.map(name => `    '${name}',\n`).join('');
  assert.equal(actual.toString().split(addition).length, 2);
  const before = Buffer.from(actual.toString().replace(addition, ''));
  assert.equal(before.length, COMPATIBILITY_PRELOAD_EXTENSION.bytes);
  assert.equal(sha(before), COMPATIBILITY_PRELOAD_EXTENSION.sha256);
  assert.deepEqual(before, execFileSync('git', ['show', '09370f19d4422be3b387047999a0722961c52e1e:apps/desktop/test/preload.test.ts'], { cwd: repository }));
  const rows = assertCompatibilityLegacyInputs(read(COMPATIBILITY_LEGACY_INPUTS.path), read);
  assert.equal(rows.length, 49);
  for (const row of rows.filter(row => row.path !== COMPATIBILITY_PRELOAD_EXTENSION.path)) {
    const bytes = read(row.path); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
  }
});

for (const [name, before, after] of [
  ['原冻结对象断言', 'assert.equal(Object.isFrozen(api), true)', 'assert.equal(true, true)'],
  ['原context采集计数', ").length, 6, '共享读写范围", ").length, 7, '共享读写范围"],
  ['原loader白名单', 'assert.ok(Object.hasOwn(modules, name)', 'assert.ok(true'],
]) test(`012拒绝放宽${name}`, () => {
  const original = read(COMPATIBILITY_PRELOAD_EXTENSION.path).toString(); assert.ok(original.includes(before));
  const changed = Buffer.from(original.replace(before, after));
  assert.throws(() => assertCompatibilityLegacyInputs(read(COMPATIBILITY_LEGACY_INPUTS.path),
    file => file === COMPATIBILITY_PRELOAD_EXTENSION.path ? changed : read(file)));
});

function frozenGroups() {
  const directories = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'];
  const own = ['packages/contracts/test/mbrs012/contract.test.ts', 'packages/bridge-core/test/mbrs012/positive.test.ts', 'apps/desktop/test/mbrs012-ipc.test.ts'];
  const groups = directories.map((directory, index) => ({ name: `writer-${index}`, directory, expectedTests: 1,
    tests: [...SOURCE_WRITES_REGRESSION_TESTS.filter(file => file.startsWith(directory + '/')), own[index]].map(file => file.slice(directory.length + 1)) }));
  return { own, scope: { schema: 'mbrs012.source-writes-scope.v1', baseSha: '09370f19d4422be3b387047999a0722961c52e1e',
    implementationComplete: true, countsConfirmed: true, sourceFilesWrite: 'DEFAULT_OFF_SPECIFIC_QUALIFIED_PLAN_ONLY', groups } };
}
test('012Gate拒绝未实测计数、漏回归、漏专项和混入其他任务', () => {
  const value = frozenGroups(); assert.equal(assertSourceWritesScope(value.scope, value.own).length, 3);
  for (const change of [
    scope => { scope.countsConfirmed = false; }, scope => { scope.implementationComplete = false; },
    scope => { scope.groups[0].tests.shift(); }, scope => { scope.groups[0].tests.push('test/mbrs015/fake.test.ts'); },
    scope => { scope.groups[0].expectedTests = 0; },
  ]) { const copy = structuredClone(value.scope); change(copy); assert.throws(() => assertSourceWritesScope(copy, value.own)); }
  assert.throws(() => assertSourceWritesScope(value.scope, [...value.own, 'packages/contracts/test/mbrs012/missing.test.ts']));
});
test('012完整stage要求真实close/退出0/null/无skip、超时或残留', () => {
  const stage = { exitCode: 0, signal: null, closeObserved: true, timedOut: false, overflow: false,
    captureFailed: false, preparationFailed: false, groupTerminationFailed: false, expectedTests: 2,
    tapStatusesClean: true, testCounts: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 } };
  assert.equal(sourceWritesStageSucceeded(stage), true);
  for (const changed of [{ exitCode: 1 }, { signal: 'SIGTERM' }, { closeObserved: false }, { timedOut: true },
    { overflow: true }, { captureFailed: true }, { preparationFailed: true }, { groupTerminationFailed: true },
    { tapStatusesClean: false }, { testCounts: { ...stage.testCounts, pass: 1, skipped: 1 } }])
    assert.equal(sourceWritesStageSucceeded({ ...stage, ...changed }), false);
});
