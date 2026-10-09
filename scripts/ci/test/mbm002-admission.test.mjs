import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMbm002Admission, MBM002_BASE, MBM002_BUDGETS, MBM002_OPERATIONS } from '../mbm002-admission.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const json = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const clone = value => structuredClone(value);
const groups = {
  contracts: ['packages/contracts/test', name => name.startsWith('mbm002-')],
  core: ['packages/bridge-core/test/mbm002', () => true],
  desktop: ['apps/desktop/test/mbm002', () => true],
};
/** 正例读取当前整份 wire/范围/账本与全部实存测试源码，不执行产品或把 census 当运行证据。 */
function readFixture() {
  const execution = json('docs/postrust/MBM-002/EXECUTION_SCOPE.json');
  const canonicalBytes = readFileSync(path.join(root, 'packages/contracts/mobile/openapi.json'));
  const status = json('project/STATUS.json'), plan = json('project/POSTRUST_PLAN.json');
  const discovered = Object.fromEntries(Object.entries(groups).map(([area, [directory, include]]) =>
    [area, readdirSync(path.join(root, directory)).filter(include).map(name => directory + '/' + name).sort()]));
  const tests = { schema: 'musicbridge.mbm002.test-scope.v1', task: 'MBM-002', baseSha: MBM002_BASE, gateBudgets: clone(MBM002_BUDGETS) };
  for (const [area, files] of Object.entries(discovered)) {
    const testFiles = files.filter(file => file.endsWith('.test.ts')), helperFiles = files.filter(file => !file.endsWith('.test.ts'));
    const caseNames = testFiles.flatMap(file => [...readFileSync(path.join(root, file), 'utf8').matchAll(/^test\('([^']+)'/gmu)].map(match => match[1]));
    tests[area] = { testFiles, helperFiles, expectedTests: caseNames.length, caseNames };
  }
  // Root会填正式scope；纯准入fixture补齐尚未写入的预算/写权限，不改实际文件。
  execution.canonicalBytes ??= 145918; execution.gateBudgets ??= clone(MBM002_BUDGETS); execution.sourceFilesWrite ??= false;
  status.mobilePlaybackResources.branch ??= execution.branch;
  const original = file => JSON.parse(execFileSync('git', ['show', MBM002_BASE + ':' + file],
    { cwd: root, encoding: 'utf8', maxBuffer: MBM002_BUDGETS.sourceFileBytes }));
  return { execution, tests, canonical: JSON.parse(canonicalBytes.toString('utf8')), canonicalBytes,
    status, plan, originalPlan: original('project/POSTRUST_PLAN.json'), originalStatus: original('project/STATUS.json'), discovered };
}
const baseline = readFixture();
function fixture() {
  const value = clone(baseline); value.canonicalBytes = Buffer.from(baseline.canonicalBytes); return value;
}
const rejects = (value, code) => assert.throws(() => assertMbm002Admission(value), error => error?.code === code);

test('002当前整份40操作与10操作子域可准入；软件和自有App状态不替代实际Gate', () => {
  const f = fixture();
  assert.equal(f.canonicalBytes.length, 145918); assert.equal(MBM002_OPERATIONS.length, 10);
  assert.deepEqual([f.tests.contracts.expectedTests, f.tests.core.expectedTests, f.tests.desktop.expectedTests], [15, 30, 36]);
  assert.equal(assertMbm002Admission(f), true);
  for (const object of [f.execution, f.status.mobilePlaybackResources]) {
    object.software = 'PASS_LOCAL_CONTROLLED_EVIDENCE'; object.productionApp = 'PASS_LOCAL_CONTROLLED_APP';
    object.actualSelfOwnedMacMedia = 'PASS_SELF_OWNED_MAC_NOT_DEVICE_OWNER';
  }
  for (const row of [f.status.mobileFrontloading20261008.mobileTasks, f.plan.mobile_tasks].map(rows => rows.find(row => row.id === 'MBM-002'))) {
    row.software = 'PASS_LOCAL_CONTROLLED_EVIDENCE'; row.production_app = 'PASS_LOCAL_CONTROLLED_APP';
  }
  assert.equal(assertMbm002Admission(f), true);
});

test('002原base分支整wire和冻结预算逐值绑定，不能用同长度替换或伪造解析对象', () => {
  for (const [key, value] of [['baseSha', '0'.repeat(40)], ['branch', 'codex/wrong'], ['repeatedOwnerApprovalRequired', true],
    ['canonicalBytes', 145919], ['frozenCanonicalSha256', '0'.repeat(64)]]) {
    const f = fixture(); f.execution[key] = value; rejects(f, 'MBM002_SCOPE_CHANGED');
  }
  for (const key of Object.keys(MBM002_BUDGETS)) {
    const execution = fixture(); execution.execution.gateBudgets[key]++; rejects(execution, 'MBM002_SCOPE_CHANGED');
    const scope = fixture(); scope.tests.gateBudgets[key]++; rejects(scope, 'MBM002_TEST_SCOPE_CHANGED');
  }
  const changed = fixture(); changed.canonicalBytes = Buffer.from(changed.canonicalBytes); changed.canonicalBytes[0] ^= 1; rejects(changed, 'MBM002_SCOPE_CHANGED');
  const appended = fixture(); appended.canonicalBytes = Buffer.concat([appended.canonicalBytes, Buffer.from('\n')]); rejects(appended, 'MBM002_SCOPE_CHANGED');
  const version = fixture(); version.canonical.info.version = '1.6.1'; rejects(version, 'MBM002_WIRE_CHANGED');
  const spec = fixture(); spec.canonical.openapi = '3.0.0'; rejects(spec, 'MBM002_WIRE_CHANGED');
  const operations = fixture(); operations.execution.operations.pop(); rejects(operations, 'MBM002_SCOPE_CHANGED');
  const wire = fixture(); const item = Object.values(wire.canonical.paths).find(item => item.get?.operationId === 'getResource');
  assert.ok(item); item.get.operationId = 'unregisteredResource'; rejects(wire, 'MBM002_WIRE_CHANGED');
});

test('002源写第二作者Rust和旧loopback权限不扩张；未有手机账号和Owner证据仍NOT_RUN', () => {
  const source = fixture(); source.execution.sourceFilesWrite = true; rejects(source, 'MBM002_SCOPE_CHANGED');
  for (const [key, value] of [['optionalRust', 'ON'], ['controlAndOriginalStream', 'PUBLIC'], ['nodeDatasetWriter', 'SECOND_WRITER'],
    ['mbm001AcceptanceCases', 8], ['mbm001FrozenEvidence', false], ['mbm003And004NotStarted', false]]) {
    const f = fixture(); f.execution.preserve[key] = value; rejects(f, 'MBM002_SCOPE_CHANGED');
  }
  for (const key of ['nativeIOSDeviceAudio', 'realProviderRoonNAS', 'ownerAcceptance']) {
    const f = fixture(); f.execution[key] = 'PASS'; rejects(f, 'MBM002_SCOPE_CHANGED');
  }
  for (const key of ['nativeIOSDeviceAudio', 'ownerAcceptance', 'realProviderRoonNAS']) {
    const f = fixture(); f.status.mobilePlaybackResources[key] = 'PASS'; rejects(f, 'MBM002_AUTHORITY_CHANGED');
  }
});

test('002原18任务156验收及有效17/150和001九验收完整保留，不能借准入升级旧任务', () => {
  const task = fixture(); task.plan.tasks[0].status = 'PROMOTED'; rejects(task, 'MBM002_ORIGINAL_LEDGER_CHANGED');
  const acceptance = fixture(); acceptance.plan.acceptance_cases[0].status = 'PROMOTED'; rejects(acceptance, 'MBM002_ORIGINAL_LEDGER_CHANGED');
  const count = fixture(); count.plan.acceptance_count++; rejects(count, 'MBM002_ORIGINAL_LEDGER_CHANGED');
  const effective = fixture(); effective.plan.effective_scope.activeAcceptanceCases++; rejects(effective, 'MBM002_ORIGINAL_LEDGER_CHANGED');
  const old = fixture(), key = Object.keys(old.originalStatus).find(key => old.originalStatus[key]?.task === 'MBRS-013');
  assert.ok(key); old.status[key].ownerAcceptance = 'PASS'; rejects(old, 'MBM002_ORIGINAL_TASK_STATE_CHANGED');
  const missing = fixture(); delete missing.status[key]; rejects(missing, 'MBM002_ORIGINAL_TASK_STATE_CHANGED');
  const extra = fixture(); extra.status.mbrs099Forged = { task: 'MBRS-099', state: 'PASS' }; rejects(extra, 'MBM002_ORIGINAL_TASK_STATE_CHANGED');
  const prior = fixture(); prior.status.mobilePairingReadonlyLibrary.independentAcceptanceCount = 8; rejects(prior, 'MBM002_ORIGINAL_TASK_STATE_CHANGED');
  const priorEvidence = fixture(); priorEvidence.status.mobilePairingReadonlyLibrary.evidence = 'forged-evidence.json'; rejects(priorEvidence, 'MBM002_ORIGINAL_TASK_STATE_CHANGED');
  const policy = fixture(); policy.status.policy.loopbackOnly = false; rejects(policy, 'MBM002_ORIGINAL_TASK_STATE_CHANGED');
});

test('002当前身份和两个独立任务row必须唯一一致，003和004不得提前开始', () => {
  for (const [key, value] of [['scope', 'docs/wrong.json'], ['baseSha', '0'.repeat(40)], ['branch', 'codex/wrong']]) {
    const f = fixture(); f.status.mobilePlaybackResources[key] = value; rejects(f, 'MBM002_AUTHORITY_CHANGED');
  }
  const lane = fixture(); lane.status.mobileFrontloading20261008.currentTask = 'MBM-003'; rejects(lane, 'MBM002_AUTHORITY_CHANGED');
  const schedule = fixture(); schedule.plan.execution_schedule.predecessor_final_report = '0'.repeat(40); rejects(schedule, 'MBM002_AUTHORITY_CHANGED');
  for (const owner of ['status', 'plan']) {
    const rows = f => owner === 'status' ? f.status.mobileFrontloading20261008.mobileTasks : f.plan.mobile_tasks;
    const duplicate = fixture(); rows(duplicate).push(clone(rows(duplicate).find(row => row.id === 'MBM-002'))); rejects(duplicate, 'MBM002_AUTHORITY_CHANGED');
    const removed = fixture(); rows(removed).splice(rows(removed).findIndex(row => row.id === 'MBM-002'), 1); rejects(removed, 'MBM002_AUTHORITY_CHANGED');
    const wrongBase = fixture(); rows(wrongBase).find(row => row.id === 'MBM-002').base_report_sha = '0'.repeat(40); rejects(wrongBase, 'MBM002_AUTHORITY_CHANGED');
    for (const id of ['MBM-003', 'MBM-004']) {
      const future = fixture(); rows(future).find(row => row.id === id).status = 'IN_PROGRESS'; rejects(future, 'MBM002_SUCCESSOR_STARTED');
      const evidence = fixture(); rows(evidence).find(row => row.id === id).software = 'PASS'; rejects(evidence, 'MBM002_SUCCESSOR_STARTED');
    }
  }
});

test('002全部实存test和helper闭集精确一致，遗漏多余重复或跨域文件都拒绝', () => {
  for (const area of ['contracts', 'core', 'desktop']) {
    const extra = fixture(); extra.discovered[area].push(extra.tests[area].testFiles[0] + '.extra.ts'); rejects(extra, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const missing = fixture(); missing.discovered[area].pop(); rejects(missing, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const duplicate = fixture(); duplicate.discovered[area].push(duplicate.discovered[area][0]); rejects(duplicate, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const unknownTest = fixture(); unknownTest.tests[area].testFiles[0] += '.test.ts'; unknownTest.discovered[area][0] = unknownTest.tests[area].testFiles[0]; rejects(unknownTest, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const helper = fixture(); const name = helper.tests[area].testFiles[0].replace('.test.ts', '-helper.ts');
    helper.tests[area].helperFiles.push(name); helper.discovered[area].push(name); rejects(helper, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const cross = fixture(); cross.tests[area].testFiles[0] = 'packages/bridge-core/test/mbm001/auth-service.test.ts'; rejects(cross, 'MBM002_TEST_SCOPE_INCOMPLETE');
  }
  const unknown = fixture(); unknown.discovered.extra = []; rejects(unknown, 'MBM002_TEST_SCOPE_CHANGED');
  const base = fixture(); base.tests.baseSha = '0'.repeat(40); rejects(base, 'MBM002_TEST_SCOPE_CHANGED');
});

test('00215/30/36完整名称不漏不重且跨组唯一，getter和空洞不能变成准入事实', () => {
  for (const area of ['contracts', 'core', 'desktop']) {
    const count = fixture(); count.tests[area].expectedTests--; rejects(count, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const missing = fixture(); missing.tests[area].caseNames.pop(); rejects(missing, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const extra = fixture(); extra.tests[area].caseNames.push('多余未执行用例'); rejects(extra, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const duplicate = fixture(); duplicate.tests[area].caseNames[0] = duplicate.tests[area].caseNames[1]; rejects(duplicate, 'MBM002_TEST_SCOPE_INCOMPLETE');
    const newline = fixture(); newline.tests[area].caseNames[0] += '\n伪TAP'; rejects(newline, 'MBM002_TEST_SCOPE_INCOMPLETE');
  }
  const cross = fixture(); cross.tests.desktop.caseNames[0] = cross.tests.core.caseNames[0]; rejects(cross, 'MBM002_TEST_SCOPE_INCOMPLETE');
  const hole = fixture(); delete hole.discovered.core[0]; rejects(hole, 'MBM002_TEST_SCOPE_CHANGED');
  const getter = fixture(); let invoked = 0;
  Object.defineProperty(getter.execution, 'baseSha', { enumerable: true, get() { invoked++; return MBM002_BASE; } });
  rejects(getter, 'MBM002_SCOPE_CHANGED'); assert.equal(invoked, 0);
});
