import assert from 'node:assert/strict';
import test from 'node:test';
import { taskApplicabilityRoute, taskApplicabilityWorkflowOutputs } from '../task-applicability.mjs';
import { TAPE_CATALOG_COMMON_TASK, TAPE_CATALOG_COMMON_BRANCH } from '../tape-catalog-common-admission.mjs';

test('组合分支即使缺少独立记录也必须进入完整组合准入', () => {
  for (const record of [null, {}, { task: 'legacy' }])
    assert.equal(taskApplicabilityRoute(TAPE_CATALOG_COMMON_BRANCH, record), 'EXACT_TAPE_COMMON');
});

test('组合记录不能借改名分支绕回旧准入', () => {
  for (const branch of ['', 'codex/unknown', 'codex/fix-local-library-loading'])
    assert.equal(taskApplicabilityRoute(branch, { task: TAPE_CATALOG_COMMON_TASK }), 'EXACT_TAPE_COMMON');
});

test('原修复和移动分支保留原准入作者', () => {
  for (const branch of ['codex/fix-local-library-loading', 'codex/mbm-003-lossless-dsd-transport', 'codex/tape-catalog-r3-import'])
    assert.equal(taskApplicabilityRoute(branch, null), 'ORIGINAL_LOCAL_FIX_OR_MOBILE');
});

function localFixResult() {
  return { schema: 'musicbridge.local-library-signed-stat-fix.admission.v1', task: 'LOCAL_LIBRARY_SIGNED_STAT_FIX',
    branch: 'codex/fix-local-library-loading', baseSha: '5e96372f0dd99e08b1e2964d68ce234eb438bbdf',
    headAtAdmission: 'fd176fdf1da069dd678b673f697cdbe8831628cc', exactProductFiles: 12, exactCompatibilityFiles: 6,
    oldGateEvidenceReused: true, currentFixSoftwareGateRequired: true, currentFixAppDeviceOwnerProven: false };
}

test('精确旧修复输出保留fresh软件Gate并明确旧移动证据仅复用', () => {
  assert.deepEqual(taskApplicabilityWorkflowOutputs(localFixResult()), {
    task: 'LOCAL_LIBRARY_SIGNED_STAT_FIX', mobileTask: 'reuse-frozen', legacyGateMode: 'reuse-frozen',
    localLibraryFixTask: 'LOCAL_LIBRARY_SIGNED_STAT_FIX', combinedGateMode: 'not-applicable',
  });
});

test('不完整旧修复结果不能取得复用输出或冒充应用验收', () => {
  const mutations = { schema: 'forged', branch: 'codex/unknown', baseSha: '0'.repeat(40), headAtAdmission: '',
    exactProductFiles: 11, exactCompatibilityFiles: 5, oldGateEvidenceReused: false,
    currentFixSoftwareGateRequired: false, currentFixAppDeviceOwnerProven: true };
  for (const [key, value] of Object.entries(mutations)) {
    const result = localFixResult(); result[key] = value;
    assert.throws(() => taskApplicabilityWorkflowOutputs(result), { code: 'TASK_LOCAL_FIX_RESULT_INCOMPLETE' });
  }
});

test('完整legacy结果必须明确执行历史Gate', () => {
  assert.deepEqual(taskApplicabilityWorkflowOutputs({ task: 'legacy', oldGateEvidenceReused: false }), {
    task: 'legacy', mobileTask: 'legacy', legacyGateMode: 'run',
    localLibraryFixTask: 'not-applicable', combinedGateMode: 'not-applicable',
  });
});

test('未知或未经完整准入的结果不生成跳过输出', () => {
  for (const result of [null, {}, { task: 'unknown' }, { task: 'legacy', oldGateEvidenceReused: true },
    { task: TAPE_CATALOG_COMMON_TASK }, { task: 'MBM-003', oldGateEvidenceReused: true }])
    assert.throws(() => taskApplicabilityWorkflowOutputs(result));
});
