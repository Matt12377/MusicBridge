import assert from 'node:assert/strict';
import test from 'node:test';
import { MBM004_BRANCH, MBM004_BASE, MBM004_SCOPE_PATH } from '../mbm004-admission.mjs';
import { classifyMobileContentReportChanges, locateMobileContentReportTask, validateMobileContentParentCi } from '../report-only-mbm004.mjs';
const parent = 'a'.repeat(40), clone = value => structuredClone(value);
function data() {
  const row = { id: 'MBM-004', software: 'PASSED', base_report_sha: MBM004_BASE, branch: MBM004_BRANCH,
    scope_ref: MBM004_SCOPE_PATH, owner_repeated_approval_required: false,
    production_app: 'NOT_RUN', real_service_device_audio: 'NOT_RUN', owner_acceptance: 'NOT_RUN' };
  const beforeStatus = { old013: { real: 'PARTIAL' }, mobileContentMultidevice: { task: 'MBM-004', branch: MBM004_BRANCH,
    baseSha: MBM004_BASE, scope: MBM004_SCOPE_PATH, ownerRepeatedApprovalRequired: false, remotePushPolicy: 'MILESTONE_ONLY',
    software: 'PASSED', productionApp: 'NOT_RUN', realServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN', implementationCommit: null },
    mobileFrontloading20261008: { currentTask: 'MBM-004', mobileTasks: [clone(row), { id: 'MBM-003', real: 'PARTIAL' }] } };
  const beforePlan = { execution_schedule: { current_task: 'MBM-004', predecessor_final_report: MBM004_BASE,
    current_task_scope_ref: MBM004_SCOPE_PATH }, mobile_tasks: clone(beforeStatus.mobileFrontloading20261008.mobileTasks),
    tasks: Array.from({ length: 18 }, (_, i) => ({ id: i, state: 'PRESERVED' })), acceptance_cases: Array.from({ length: 156 }, (_, i) => ({ id: i, live: 'NOT_RUN' })) };
  const afterStatus = clone(beforeStatus), afterPlan = clone(beforePlan);
  afterStatus.mobileContentMultidevice.implementationCommit = parent;
  for (const rows of [afterStatus.mobileFrontloading20261008.mobileTasks, afterPlan.mobile_tasks]) rows[0].implementation_commit = parent;
  return { task: 'MBM-004', parent, beforeStatus, afterStatus, beforePlan, afterPlan,
    changes: [{ path: 'reports/MBM-004_RESULT.md', status: 'A', oldMode: '000000', newMode: '100644' }] };
}
test('004唯一直接Source报告只更报告账，本轮软件与真实未验收各层保留', () => {
  const value = data(); assert.equal(locateMobileContentReportTask(value.beforeStatus, value.beforePlan), 'MBM-004');
  assert.equal(classifyMobileContentReportChanges(value), true);
});
test('004报告不得改源码、范围、历史、后继、真实App或Owner层', () => {
  for (const edit of [v => { v.changes.push({ path: 'packages/bridge-core/src/runtime.ts', status: 'M', oldMode: '100644', newMode: '100644' }); },
    v => { v.changes[0].newMode = '120000'; }, v => { v.afterStatus.old013.real = 'PASSED'; },
    v => { v.afterStatus.mobileContentMultidevice.productionApp = 'PASSED'; }, v => { v.afterStatus.mobileContentMultidevice.ownerAcceptance = 'PASSED'; },
    v => { v.afterStatus.mobileContentMultidevice.scope = 'other'; }, v => { v.afterPlan.acceptance_cases[0].live = 'PASSED'; },
    v => { v.afterPlan.mobile_tasks[1].real = 'PASSED'; }, v => { v.afterStatus.mobileContentMultidevice.implementationCommit = MBM004_BASE; },
    v => { v.afterPlan.execution_schedule.current_task = 'MBRS-016'; }, v => { v.afterPlan.mobile_tasks[0].implementation_commit = MBM004_BASE; }]) {
    const value = data(); edit(value); assert.equal(classifyMobileContentReportChanges(value), false);
  }
});
function ci() {
  const files = ['verify', 'security', 'rust-core', 'electron-e2e'];
  const names = [ ['MBM004 内容与多设备软件 Gate', 'Verify platform-independent workspace (typecheck, unit tests, build; no Electron)', 'Production dependency audit'],
    ['Run directed platform-independent security tests (no Electron)'], ['验证实际 Rust 与 TypeScript 边界'],
    ['Electron startup, crash/restart, safeStorage vault and credential recovery gates', 'Electron end-to-end flow (Playwright, production build)'] ];
  const artifactNames = [[`verify-${parent}`], [], [`rust-core-ubuntu-latest-${parent}`, `rust-core-macos-latest-${parent}`],
    [`rust-host-compiled-${parent}`, `electron-e2e-${parent}`]];
  const runs = files.map((file, i) => ({ id: i + 1, path: `.github/workflows/${file}.yml`, repository: { id: 42 }, head_repository: { id: 42 },
    head_sha: parent, head_branch: MBM004_BRANCH, event: 'push', run_attempt: 1, status: 'completed', conclusion: 'success' }));
  const proofs = runs.map((run, i) => ({ runId: run.id, jobs: Array.from({ length: [2,1,2,1][i] }, (_, j) => ({ id: 100+i*10+j,
    run_id: run.id, head_sha: parent, status: 'completed', conclusion: 'success', steps: (j === 0 || i === 2 ? names[i] : [])
      .map(name => ({ name, status: 'completed', conclusion: 'success' })) })),
    artifacts: artifactNames[i].map((name,j) => ({ id: 1000+i*10+j, name, expired: false, size_in_bytes: 100, digest: 'sha256:'+'d'.repeat(64),
      expires_at: '2030-02-01T00:00:00Z', workflow_run: { id: run.id, head_sha: parent, repository_id: 42, head_repository_id: 42 } })) }));
  return { task: 'MBM-004', parent, branch: MBM004_BRANCH, repositoryId: 42, runs, proofs, now: Date.parse('2030-01-01T00:00:00Z') };
}
test('004父源码必须完整4自然push、6jobs、5精确producer制品和本轮Gate', () => {
  assert.equal(validateMobileContentParentCi(ci()), true);
});
test('004缺项、复跑、错SHA、未结束、错producer、过期或缺实际Gate不能复用', () => {
  for (const edit of [v => { v.runs.pop(); }, v => { v.runs.push(clone(v.runs[0])); }, v => { v.runs[0].run_attempt = 2; },
    v => { v.runs[0].head_sha = MBM004_BASE; }, v => { v.runs[0].event = 'workflow_dispatch'; },
    v => { v.runs[0].head_repository.id = 7; }, v => { v.proofs[0].jobs[0].head_sha = MBM004_BASE; },
    v => { v.proofs[0].jobs[0].steps[0].conclusion = 'skipped'; }, v => { v.proofs[2].jobs.pop(); },
    v => { v.proofs[3].artifacts[0].name = 'wrong-producer'; }, v => { v.proofs[0].artifacts[0].expired = true; },
    v => { v.proofs[0].artifacts[0].expires_at = '2029-01-01T00:00:00Z'; },
    v => { v.proofs[0].artifacts[0].workflow_run.repository_id = 7; }, v => { v.proofs[0].artifacts[0].digest = null; }]) {
    const value = ci(); edit(value); assert.equal(validateMobileContentParentCi(value), false);
  }
});
