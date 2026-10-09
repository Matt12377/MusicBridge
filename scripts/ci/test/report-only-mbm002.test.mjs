import test from 'node:test';
import assert from 'node:assert/strict';
import { locateMobilePlaybackReportTask, classifyMobilePlaybackReportChanges,
  validateMobilePlaybackParentCi } from '../report-only-mbm002.mjs';
import { locateMobilePairingReportTask, classifyMobilePairingReportChanges, validateMobilePairingParentCi,
  locateMobileReportTask, classifyMobileReportChanges, validateMobileParentCi } from '../report-only-admission.mjs';

// 所有Source、账本和平台producer均为合成输入；此组不运行Git/API/产品，也不读取ZIP内容。
const task = 'MBM-002', parent = 'a'.repeat(40), base = '8044d935e242d8647adc21445116fb49c9100e4a';
const branch = 'codex/mbm-002-phone-resource-playback';
const scope = 'docs/postrust/MBM-002/EXECUTION_SCOPE.json', authority = 'mobilePlaybackResources';
const report = 'reports/MBM-002_RESULT.md', evidence = 'docs/postrust/MBM-002/evidence/source-ci.json';
const workflowPaths = ['verify', 'security', 'rust-core', 'electron-e2e'].map(name => '.github/workflows/' + name + '.yml');
const gateNames = ['MBRS013 同内容位置迁移与具体清理 Gate', 'MBM000 移动合同双端采纳 Gate',
  'MBM001 配对与只读曲库 Gate', 'MBM002 手机资源播放 Gate'];
const clone = value => structuredClone(value);
const change = name => ({ path: name, status: 'M', oldMode: '100644', newMode: '100644' });
const statusRow = status => status.mobileFrontloading20261008.mobileTasks.find(row => row.id === task);
const planRow = plan => plan.mobile_tasks.find(row => row.id === task);

function data() {
  const row = { id: task, title: '手机资源播放', status: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING', scope_ref: scope,
    base_report_sha: base, software: 'FINITE_SOFTWARE_PASS', production_app: 'FINITE_OWNED_APP_PASS',
    actual_self_owned_mac_media: 'FINITE_OWNED_MEDIA_PASS', native_ios_device_audio: 'NOT_RUN',
    real_service_device_audio: 'NOT_RUN', owner_acceptance: 'NOT_RUN', owner_repeated_approval_required: false,
    scheduled_after: 'MBM-001' };
  const mobile = [{ id: 'MBM-000', status: 'SOFTWARE_DELIVERY_SEALED', real_service_device_audio: 'NOT_RUN' },
    { id: 'MBM-001', status: 'SOFTWARE_DELIVERY_SEALED', report_commit: base, real_service_device_audio: 'NOT_RUN',
      owner_acceptance: 'NOT_RUN', evidence_refs: ['docs/postrust/MBM-001/evidence/source-ci.json'] }, clone(row),
    ...['MBM-003', 'MBM-004'].map(id => ({ id, status: 'NOT_STARTED', software: 'NOT_RUN', owner_acceptance: 'NOT_RUN' }))];
  const beforeStatus = { currentPostRustTask: 'MBRS-013',
    old013: { task: 'MBRS-013', originalEight: 'PARTIAL', live: 'NOT_RUN', owner: 'NOT_RUN' },
    mobileContractAdoption: { task: 'MBM-000', state: 'SOFTWARE_DELIVERY_SEALED', realServiceDeviceAudioOwner: 'NOT_RUN' },
    mobilePairingReadonlyLibrary: { task: 'MBM-001', state: 'SOFTWARE_DELIVERY_SEALED', reportCommit: base,
      realServiceDeviceAudioOwner: 'NOT_RUN', evidence: ['docs/postrust/MBM-001/evidence/source-ci.json'] },
    [authority]: { task, state: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING', branch, baseSha: base, scope,
      implementationCommit: null, reportCommit: null, software: 'FINITE_SOFTWARE_PASS', productionApp: 'FINITE_OWNED_APP_PASS',
      actualSelfOwnedMacMedia: 'FINITE_OWNED_MEDIA_PASS', nativeIOSDeviceAudio: 'NOT_RUN', realProviderRoonNAS: 'NOT_RUN',
      ownerAcceptance: 'NOT_RUN', peerAdoption: 'PEER_FINAL_REPORT_PENDING', pairedAdoptionComplete: false,
      ownerRepeatedApprovalRequired: false, sourceFilesWrite: false, defaultCore: 'NODE', optionalRustReadonly: 'OFF',
      sqliteWriter: 'EXISTING_DATASET_OWNER_ONLY', controlAndOriginalStream: 'LOOPBACK', newMobileHttpsDefault: 'OFF',
      canonical: 'packages/contracts/mobile/openapi.json', canonicalSha256: 'd'.repeat(64), nextTask: 'MBM-003',
      gateBudgets: { stageTimeoutMs: 180000, totalTimeoutMs: 420000 },
      mediaBudgets: { maxChunkBytes: 65536, idleMs: 5000, establishMs: 10000, releaseMs: 10000, activeMedia: 16 },
      iosSourceSha: '9'.repeat(40), iosFinalDelivery: 'PENDING_NOT_COORDINATOR_MESSAGE' },
    mobileFrontloading20261008: { currentTask: task, nextTask: 'MBM-003', state: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING',
      originalTasks: 18, originalAcceptanceCases: 156, effectiveTasks: 17, effectiveAcceptanceCases: 150,
      ownerRepeatedApprovalRequired: false, mobileTasks: clone(mobile) } };
  const beforePlan = { execution_schedule: { current_task: task, current_task_scope_ref: scope,
    predecessor_final_report: base, remaining_sequence: [task, 'MBM-003', 'MBM-004', 'MBRS-016', 'MBRS-017'] },
    mobile_tasks: clone(mobile), tasks: Array.from({ length: 18 }, (_, index) => ({ id: 'MBRS-' + String(index).padStart(3, '0'),
      status: index === 15 ? 'CANCELLED' : 'PARTIAL', depends_on: [], goal: '合成原任务，不能由移动报告修改' })),
    acceptance_cases: Array.from({ length: 156 }, (_, index) => ({ id: '原AT-' + index,
      task: index < 8 ? 'MBRS-013' : index < 14 ? 'MBRS-015' : 'MBRS-002',
      software_status: index >= 8 && index < 14 ? 'N_A' : 'PARTIAL', live_status: index >= 8 && index < 14 ? 'N_A' : 'NOT_RUN',
      owner_status: index >= 8 && index < 14 ? 'N_A' : 'NOT_RUN', requirement: '合成原要求，不能放宽', evidence_refs: [] })),
    mobile_acceptance_cases: Array.from({ length: 9 }, (_, index) => ({ id: 'MBM001-合成AT-' + index,
      task: 'MBM-001', software_status: 'PARTIAL', real_status: 'NOT_RUN', owner_status: 'NOT_RUN' })) };
  const afterStatus = clone(beforeStatus), afterPlan = clone(beforePlan);
  afterStatus[authority].implementationCommit = parent;
  afterStatus[authority].report = report; afterStatus[authority].evidence = [evidence, report];
  for (const value of [statusRow(afterStatus), planRow(afterPlan)]) {
    value.implementation_commit = parent; value.report_path = report; value.evidence_refs = [evidence, report];
  }
  return { task, parent, beforeStatus, afterStatus, beforePlan, afterPlan,
    changes: [{ ...change(report), status: 'A', oldMode: '000000' }, change('project/STATUS.json'), change('project/POSTRUST_PLAN.json')] };
}
function rejectEdits(edits) {
  for (const edit of edits) { const value = data(); edit(value); assert.equal(classifyMobilePlaybackReportChanges(value), false); }
}

test('002报告：独立唯一定位和精确父Source记账；仅原mobile报告字段可变化', () => {
  const value = data();
  assert.equal(locateMobilePlaybackReportTask(value.beforeStatus, value.beforePlan), task);
  assert.equal(locateMobilePlaybackReportTask(value.afterStatus, value.afterPlan), task);
  Object.assign(value.afterStatus[authority], { implementationCommitResolution: 'EXACT_PARENT_SOURCE', reportCommit: 'RESOLVE_HEAD',
    reportCommitResolution: 'RESOLVE_FINAL_REPORT_HEAD', push: { source: '合成平台记录' }, ci: { source: evidence },
    updatedAt: '2026-10-09T00:00:00Z', finalDeliveryReceipt: 'PRIVATE_EXTERNAL_AFTER_R', nextBranchBaseline: 'RESOLVE_FINAL_R' });
  for (const row of [statusRow(value.afterStatus), planRow(value.afterPlan)]) Object.assign(row, {
    implementation_commit_resolution: 'EXACT_PARENT_SOURCE', report_commit: 'RESOLVE_HEAD',
    report_commit_resolution: 'RESOLVE_FINAL_REPORT_HEAD', terminal_ci_receipt: { source: evidence } });
  assert.equal(classifyMobilePlaybackReportChanges(value), true);
  assert.equal(value.beforePlan.tasks.length, 18); assert.equal(value.beforePlan.acceptance_cases.length, 156);
  assert.equal(value.beforePlan.mobile_acceptance_cases.length, 9);
});

test('002报告：authority、task行重复或缺失、scope/branch/base及schedule错配拒绝', () => {
  rejectEdits([
    value => { delete value.afterStatus[authority]; },
    value => { value.afterStatus.other002 = clone(value.afterStatus[authority]); },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks.push(clone(planRow(value.afterPlan))); },
    value => { value.afterPlan.mobile_tasks.push(clone(planRow(value.afterPlan))); },
    value => { value.afterPlan.mobile_tasks = value.afterPlan.mobile_tasks.filter(row => row.id !== task); },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks = value.afterStatus.mobileFrontloading20261008.mobileTasks.filter(row => row.id !== task); },
    value => { value.beforeStatus.mobileFrontloading20261008.currentTask = 'MBM-001'; },
    value => { value.afterPlan.execution_schedule.current_task = 'MBM-003'; },
    value => { value.afterStatus[authority].branch = 'codex/mbm-001-pairing-readonly-library'; },
    value => { value.afterStatus[authority].baseSha = parent; },
    value => { value.afterStatus[authority].scope = 'docs/postrust/MBM-001/EXECUTION_SCOPE.json'; },
    value => { value.afterPlan.execution_schedule.current_task_scope_ref = 'docs/other.json'; },
    value => { value.afterPlan.execution_schedule.predecessor_final_report = parent; },
    value => { planRow(value.afterPlan).base_report_sha = parent; },
    value => { statusRow(value.afterStatus).scope_ref = 'docs/other.json'; },
    value => { planRow(value.afterPlan).software = '别的Source状态'; },
  ]);
  const value = data();
  for (const status of [value.beforeStatus, value.afterStatus]) status[authority].baseSha = parent;
  for (const plan of [value.beforePlan, value.afterPlan]) plan.execution_schedule.predecessor_final_report = parent;
  assert.equal(locateMobilePlaybackReportTask(value.afterStatus, value.afterPlan), null);
});

test('002报告：authority与双份task行都须绑定相同精确Source和完整报告记账', () => {
  rejectEdits([
    value => { value.task = 'MBM-001'; }, value => { value.parent = 'unknown'; }, value => { value.parent += '\n'; },
    value => { value.afterStatus[authority].implementationCommit = base; },
    value => { delete planRow(value.afterPlan).implementation_commit; },
    value => { statusRow(value.afterStatus).implementation_commit = base; },
    value => { planRow(value.afterPlan).report_path = 'reports/MBM-002_OTHER.md'; },
    value => { statusRow(value.afterStatus).evidence_refs.push('仅一侧的新材料'); },
  ]);
});

test('002报告：software/App/自有媒体/设备/真实/Owner和对端采纳不得在R升层', () => {
  for (const field of ['state', 'software', 'productionApp', 'actualSelfOwnedMacMedia', 'nativeIOSDeviceAudio',
    'realProviderRoonNAS', 'ownerAcceptance', 'peerAdoption', 'pairedAdoptionComplete', 'iosSourceSha', 'iosFinalDelivery']) {
    const value = data(); value.afterStatus[authority][field] = 'PASS';
    assert.equal(classifyMobilePlaybackReportChanges(value), false, field);
  }
  for (const field of ['status', 'software', 'production_app', 'actual_self_owned_mac_media', 'native_ios_device_audio',
    'real_service_device_audio', 'owner_acceptance', 'validation_status']) {
    const value = data();
    for (const row of [statusRow(value.afterStatus), planRow(value.afterPlan)]) row[field] = 'PASS';
    assert.equal(classifyMobilePlaybackReportChanges(value), false, field);
  }
});

test('002报告：权限、Node唯一writer、loopback、OFF、预算、canonical和未知字段冻结', () => {
  for (const field of ['ownerRepeatedApprovalRequired', 'sourceFilesWrite', 'defaultCore', 'optionalRustReadonly',
    'sqliteWriter', 'controlAndOriginalStream', 'newMobileHttpsDefault', 'canonical', 'canonicalSha256', 'gateBudgets',
    'mediaBudgets', 'scope', 'nextTask', 'unknownPermission']) {
    const value = data(); value.afterStatus[authority][field] = '新值';
    assert.equal(classifyMobilePlaybackReportChanges(value), false, field);
  }
  rejectEdits([
    value => { value.afterStatus[authority].mediaBudgets.releaseMs++; },
    value => { value.afterStatus.mobileFrontloading20261008.state = 'COMPLETE'; },
    value => { value.afterStatus.mobileFrontloading20261008.nextTask = 'MBM-004'; },
    value => { value.afterPlan.execution_schedule.remaining_sequence = ['MBM-003']; },
    value => { for (const row of [statusRow(value.afterStatus), planRow(value.afterPlan)]) row.owner_repeated_approval_required = true; },
  ]);
});

test('002报告：原18/156与17/150、013八PARTIAL、015六N_A、001证据及003004不变', () => {
  rejectEdits([
    value => { value.afterStatus.currentPostRustTask = 'MBRS-016'; },
    value => { value.afterStatus.old013.originalEight = 'PASS'; },
    value => { value.afterStatus.mobileContractAdoption.realServiceDeviceAudioOwner = 'PASS'; },
    value => { value.afterStatus.mobilePairingReadonlyLibrary.evidence.push(evidence); },
    value => { value.afterStatus.mobilePairingReadonlyLibrary.realServiceDeviceAudioOwner = 'PASS'; },
    ...['originalTasks', 'originalAcceptanceCases', 'effectiveTasks', 'effectiveAcceptanceCases'].map(field =>
      value => { value.afterStatus.mobileFrontloading20261008[field]++; }),
    value => { value.afterPlan.tasks[13].status = 'PASS'; },
    value => { value.afterPlan.tasks[15].status = 'PASS'; },
    value => { value.afterPlan.tasks[1].depends_on = ['MBM-002']; },
    value => { value.afterPlan.acceptance_cases[7].software_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[7].live_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[7].owner_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[8].software_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[0].evidence_refs.push(evidence); },
    value => { value.afterPlan.acceptance_cases[155].requirement = '放宽'; },
    value => { value.afterPlan.mobile_acceptance_cases[0].software_status = 'PASS'; },
    value => { value.afterPlan.tasks.pop(); }, value => { value.afterPlan.acceptance_cases.pop(); },
    ...['MBM-001', 'MBM-003', 'MBM-004'].map(id => value => {
      for (const rows of [value.afterPlan.mobile_tasks, value.afterStatus.mobileFrontloading20261008.mobileTasks])
        rows.find(row => row.id === id).status = 'IN_PROGRESS';
    }),
  ]);
});

test('002报告：仅002reports/evidence与原四metadata普通文件路径可准入', () => {
  const value = data();
  value.changes.push({ ...change(evidence), status: 'A', oldMode: '000000' },
    change('reports/MBM-002_EVIDENCE.json'), change('docs/postrust/MBM-002/evidence/software-boundary.md'),
    change('project/POSTRUST_TODO.md'), change('project/POSTRUST_PROGRESS.md'));
  assert.equal(classifyMobilePlaybackReportChanges(value), true);
  for (const name of ['packages/bridge-core/src/mobile/playback-service.ts', 'apps/desktop/src/main/mobile-media-response.ts',
    'apps/desktop/test/mbm002/mobile-playback-real-owner.test.ts', 'packages/contracts/mobile/openapi.json',
    'pnpm-lock.yaml', '.github/workflows/verify.yml', 'scripts/ci/report-only-mbm002.mjs',
    'docs/postrust/MBM-002/EXECUTION_SCOPE.json', 'docs/postrust/MBM-002/OPERATION_LIFECYCLE_MATRIX.json',
    'docs/postrust/MBM-002/MOBILE_ACCEPTANCE.json', 'docs/postrust/MBM-002/TEST_SCOPE.json',
    'tasks/MBM-002_PHONE_RESOURCE_PLAYBACK.md', 'reports/MBM-001_RESULT.md', 'reports/MBRS-013_RESULT.md',
    'docs/postrust/MBM-001/evidence/source-ci.json', 'docs/postrust/MBM-003/evidence/source.json',
    'docs/postrust/MBM-004/evidence/source.json', '../reports/MBM-002_RESULT.md', '/reports/MBM-002_RESULT.md',
    'reports/MBM-002_result.md', 'reports/MBM-002_RESULT.md\n', 'reports/MBM-002_RESULT.md\r',
    'reports/MBM-002_RESULT.md\0', 'reports/MBM-002_RESULT.md\u2028', 'reports\\MBM-002_RESULT.md',
    'docs/postrust/MBM-002/evidence/../scope.json', 'docs/postrust/MBM-002/evidence/nested/result.json',
    'docs/postrust/MBM-002/evidence/source.json\n', 'project/STATUS.json\n']) {
    const invalid = data(); invalid.changes.push(change(name));
    assert.equal(classifyMobilePlaybackReportChanges(invalid), false, name);
  }
});

test('002报告：source/delete/rename/链接/执行位/模式变更、重复路径及无report拒绝', () => {
  rejectEdits([
    value => { value.changes.shift(); }, value => { value.changes = []; },
    ...['D', 'R', 'C', 'T', 'U'].map(status => value => { value.changes[0].status = status; }),
    value => { value.changes[0].newMode = '120000'; }, value => { value.changes[0].newMode = '100755'; },
    value => { value.changes[0].newMode = '160000'; },
    value => { value.changes[0].status = 'M'; value.changes[0].oldMode = '120000'; },
    value => { value.changes[0].status = 'M'; value.changes[0].oldMode = '100755'; },
    value => { value.changes[0].oldMode = '100644'; },
    value => { value.changes.push(clone(value.changes[0])); },
    value => { value.changes[0].path = 1; }, value => { value.changes[0] = null; },
  ]);
});

test('002报告：缺失或坏输入fail-closed，JSON键序不改变真实字段相等判断', () => {
  for (const input of [undefined, null, {}, [], 1]) assert.equal(classifyMobilePlaybackReportChanges(input), false);
  for (const input of [undefined, null, {}, [], 1]) assert.equal(locateMobilePlaybackReportTask(input, input), null);
  rejectEdits([
    value => { value.afterPlan = null; }, value => { value.beforeStatus = null; },
    value => { value.afterPlan.tasks = null; }, value => { value.afterPlan.acceptance_cases = {}; },
    value => { value.afterPlan.mobile_tasks = null; }, value => { value.changes = {}; },
  ]);
  const value = data();
  value.afterStatus[authority].mediaBudgets = Object.fromEntries(Object.entries(value.afterStatus[authority].mediaBudgets).reverse());
  value.afterPlan = Object.fromEntries(Object.entries(value.afterPlan).reverse());
  assert.equal(classifyMobilePlaybackReportChanges(value), true);
});

function legacy001Data() {
  const value = data(), oldBase = 'c6c4745dfc7fe4242b8a2682798e00605649b12e';
  const oldTask = 'MBM-001', oldScope = 'docs/postrust/MBM-001/EXECUTION_SCOPE.json';
  value.task = oldTask;
  for (const status of [value.beforeStatus, value.afterStatus]) {
    status.mobilePairingReadonlyLibrary = { ...status[authority], task: oldTask, baseSha: oldBase,
      branch: 'codex/mbm-001-pairing-readonly-library', scope: oldScope };
    if (status.mobilePairingReadonlyLibrary.report) status.mobilePairingReadonlyLibrary.report = 'reports/MBM-001_RESULT.md';
    if (status.mobilePairingReadonlyLibrary.evidence) status.mobilePairingReadonlyLibrary.evidence = ['reports/MBM-001_RESULT.md'];
    delete status[authority]; status.mobileFrontloading20261008.currentTask = oldTask;
    status.mobileFrontloading20261008.mobileTasks = status.mobileFrontloading20261008.mobileTasks.filter(row => row.id !== oldTask);
    const row = statusRow(status); row.id = oldTask; row.base_report_sha = oldBase; row.scope_ref = oldScope;
    if (row.report_path) row.report_path = 'reports/MBM-001_RESULT.md';
    if (row.evidence_refs) row.evidence_refs = ['reports/MBM-001_RESULT.md'];
  }
  for (const plan of [value.beforePlan, value.afterPlan]) {
    plan.execution_schedule.current_task = oldTask; plan.execution_schedule.current_task_scope_ref = oldScope;
    plan.execution_schedule.predecessor_final_report = oldBase;
    plan.mobile_tasks = plan.mobile_tasks.filter(row => row.id !== oldTask);
    const row = planRow(plan); row.id = oldTask; row.base_report_sha = oldBase; row.scope_ref = oldScope;
    if (row.report_path) row.report_path = 'reports/MBM-001_RESULT.md';
    if (row.evidence_refs) row.evidence_refs = ['reports/MBM-001_RESULT.md'];
  }
  value.changes[0].path = 'reports/MBM-001_RESULT.md';
  return value;
}

test('002独立接线：旧001合法报告/父CI仍通过，旧013000001定位器不得误采002', () => {
  const value = data();
  assert.equal(locateMobilePairingReportTask(value.afterStatus, value.afterPlan), null);
  assert.equal(locateMobileReportTask(value.afterStatus, value.afterPlan), null);
  assert.equal(classifyMobilePairingReportChanges(value), false); assert.equal(classifyMobileReportChanges(value), false);
  assert.equal(validateMobilePairingParentCi(ciData()), false); assert.equal(validateMobileParentCi(ciData()), false);
  const old = legacy001Data();
  assert.equal(locateMobilePairingReportTask(old.afterStatus, old.afterPlan), 'MBM-001');
  assert.equal(classifyMobilePairingReportChanges(old), true); assert.equal(classifyMobilePlaybackReportChanges(old), false);
  const oldCi = ciData(); oldCi.task = 'MBM-001'; oldCi.branch = 'codex/mbm-001-pairing-readonly-library';
  for (const run of oldCi.runs) run.head_branch = oldCi.branch;
  oldCi.proofs[0].jobs[0].steps = oldCi.proofs[0].jobs[0].steps.filter(step => step.name !== gateNames[3]);
  assert.equal(validateMobilePairingParentCi(oldCi), true); assert.equal(validateMobilePlaybackParentCi(oldCi), false);
});

function ciData(source = parent) {
  const stepNames = [
    ['Verify platform-independent workspace (typecheck, unit tests, build; no Electron)', ...gateNames],
    ['Run directed platform-independent security tests (no Electron)'], ['验证实际 Rust 与 TypeScript 边界'],
    ['Electron startup, crash/restart, safeStorage vault and credential recovery gates', 'Electron end-to-end flow (Playwright, production build)'],
  ];
  const runs = workflowPaths.map((file, index) => ({ id: index + 1, path: file, head_sha: source, head_branch: branch,
    event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, repository: { id: 99 }, head_repository: { id: 99 } }));
  const artifactNames = [['verify-' + source], [], ['rust-core-ubuntu-latest-' + source, 'rust-core-macos-latest-' + source],
    ['electron-e2e-' + source, 'rust-host-compiled-' + source]];
  const proofs = runs.map((run, index) => {
    const jobs = (index === 0 ? [stepNames[index], ['Production dependency audit']]
      : index === 2 ? [stepNames[index], stepNames[index]] : [stepNames[index]]).map((names, jobIndex) => ({
      id: run.id * 100 + jobIndex, run_id: run.id, head_sha: source, status: 'completed', conclusion: 'success',
      steps: names.map(name => ({ name, status: 'completed', conclusion: 'success' })),
    }));
    return { runId: run.id, jobs, artifacts: artifactNames[index].map((name, artifactIndex) => ({ id: run.id * 10 + artifactIndex,
      name, expired: false, digest: 'sha256:' + 'd'.repeat(64), expires_at: '2099-01-01T00:00:00Z',
      workflow_run: { id: run.id, head_sha: source, repository_id: 99, head_repository_id: 99 } })) };
  });
  return { task, parent: source, repositoryId: 99, branch, runs, proofs, now: Date.parse('2026-10-09T00:00:00Z') };
}
function rejectCi(edits) {
  for (const edit of edits) { const value = ciData(); edit(value); assert.equal(validateMobilePlaybackParentCi(value), false); }
}

test('002报告CI：同Source首次自然四workflow六job五artifact及013000001002四Gate闭合', () => {
  const value = ciData();
  assert.deepEqual(value.proofs.map(proof => proof.jobs.length), [2, 1, 2, 1]);
  assert.deepEqual(value.proofs.map(proof => proof.artifacts.length), [1, 0, 2, 2]);
  assert.equal(validateMobilePlaybackParentCi(value), true);
});

test('002报告CI：四Gate均精确唯一、completed/success且属于原workspace product job', () => {
  for (const name of gateNames) rejectCi([
    value => { value.proofs[0].jobs[0].steps = value.proofs[0].jobs[0].steps.filter(step => step.name !== name); },
    ...['skipped', 'failure', 'cancelled', null].map(conclusion => value => {
      value.proofs[0].jobs[0].steps.find(step => step.name === name).conclusion = conclusion;
    }),
    value => { value.proofs[0].jobs[0].steps.find(step => step.name === name).status = 'in_progress'; },
    value => { value.proofs[0].jobs[0].steps.find(step => step.name === name).name += ' '; },
    value => { value.proofs[0].jobs[0].steps.push(clone(value.proofs[0].jobs[0].steps.find(step => step.name === name))); },
    value => { const product = value.proofs[0].jobs[0], step = product.steps.find(entry => entry.name === name);
      product.steps = product.steps.filter(entry => entry !== step); value.proofs[0].jobs[1].steps.push(step); },
    value => { value.proofs[0].jobs[1].steps.push({ name, status: 'completed', conclusion: 'skipped' }); },
  ]);
});

test('002报告CI：原平台producer步骤及2/1/2/1 job分布不能被跳过、合并或替代', () => {
  rejectCi([
    value => { value.proofs[0].jobs.pop(); value.proofs[3].jobs.push(clone(value.proofs[3].jobs[0])); },
    value => { value.proofs[2].jobs.pop(); }, value => { value.proofs[3].jobs.push(clone(value.proofs[3].jobs[0])); },
    value => { value.proofs[0].jobs[1].steps[0].status = 'in_progress'; },
    value => { value.proofs[0].jobs[0].steps.push(value.proofs[0].jobs[1].steps.pop()); },
    value => { value.proofs[1].jobs[0].steps[0].conclusion = 'skipped'; },
    value => { value.proofs[2].jobs[1].steps[0].status = 'in_progress'; },
    value => { value.proofs[3].jobs[0].steps.pop(); },
    value => { value.proofs[0].jobs[0].steps.push(clone(value.proofs[0].jobs[0].steps[0])); },
  ]);
});

test('002报告CI：run/job/artifact全域unique，重复或缺失proof与额外producer拒绝', () => {
  rejectCi([
    value => { value.runs.push(clone(value.runs[0])); }, value => { value.runs.pop(); },
    value => { value.proofs.push(clone(value.proofs[0])); }, value => { value.proofs.pop(); },
    value => { value.runs[1].id = value.runs[0].id; },
    value => { value.proofs[1].jobs[0].id = value.proofs[0].jobs[0].id; },
    value => { value.proofs[3].artifacts[0].id = value.proofs[0].artifacts[0].id; },
    value => { value.proofs[1].runId = value.proofs[0].runId; },
    value => { value.proofs[0].runId = 999; },
    value => { value.runs[1].path = value.runs[0].path; },
    value => { value.proofs[0].artifacts.push(clone(value.proofs[0].artifacts[0])); },
    value => { value.proofs[1].artifacts.push(clone(value.proofs[0].artifacts[0])); },
    value => { value.proofs[2].artifacts[1].name = value.proofs[2].artifacts[0].name; },
  ]);
});

test('002报告CI：Source/固定branch/仓库/push/attempt1和所有自然成功终态逐项绑定', () => {
  rejectCi([
    value => { value.task = 'MBM-001'; }, value => { value.parent = base; }, value => { value.parent += '\n'; },
    value => { value.branch = 'codex/other'; }, value => { value.repositoryId = 100; },
    value => { value.runs[0].head_sha = base; }, value => { value.runs[0].head_branch = 'codex/other'; },
    value => { value.runs[0].repository.id = 100; }, value => { value.runs[0].head_repository.id = 100; },
    value => { value.runs[0].event = 'workflow_dispatch'; }, value => { value.runs[0].event = 'pull_request'; },
    value => { value.runs[0].run_attempt = 2; }, value => { value.runs[0].run_attempt = 0; },
    value => { value.runs[0].status = 'in_progress'; }, value => { value.runs[0].conclusion = null; },
    value => { value.runs[1].conclusion = 'cancelled'; },
    value => { value.proofs[0].jobs[0].head_sha = base; }, value => { value.proofs[0].jobs[0].run_id = 999; },
    value => { value.proofs[0].jobs[0].conclusion = 'failure'; }, value => { value.proofs[1].jobs[0].status = 'queued'; },
    value => { value.proofs[0].jobs[0].id = 0; }, value => { value.runs[0].id = 1.5; },
    value => { value.repositoryId = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.now = NaN; }, value => { value.now = Infinity; }, value => { value.now = null; },
  ]);
});

test('002报告CI：五artifact的平台digest/有效期限和Source/run/repository精确绑定', () => {
  rejectCi([
    value => { value.proofs[0].artifacts = []; }, value => { value.proofs[0].artifacts[0].digest = null; },
    value => { value.proofs[0].artifacts[0].digest = 'sha256:unknown'; },
    value => { value.proofs[0].artifacts[0].digest += '\n'; },
    value => { value.proofs[0].artifacts[0].expired = true; }, value => { value.proofs[0].artifacts[0].expires_at = 'invalid'; },
    value => { value.proofs[0].artifacts[0].expires_at = new Date(value.now).toISOString(); },
    value => { value.proofs[0].artifacts[0].workflow_run.head_sha = base; },
    value => { value.proofs[0].artifacts[0].workflow_run.id = 999; },
    value => { value.proofs[0].artifacts[0].workflow_run.repository_id = 100; },
    value => { value.proofs[3].artifacts[1].workflow_run.head_repository_id = 100; },
    value => { value.proofs[3].artifacts[1].name = 'rust-host-compiled-' + base; },
    value => { value.proofs[2].artifacts[0].id = 0; },
  ]);
});

test('002报告CI：坏列表/空洞/null/缺步骤fail-closed，不触发外部读取或抛原内部错误', () => {
  for (const input of [undefined, null, {}, [], 1]) assert.equal(validateMobilePlaybackParentCi(input), false);
  rejectCi([
    value => { value.proofs[0].jobs[0].steps = null; }, value => { value.proofs[0].jobs[0] = null; },
    value => { value.runs[0] = null; }, value => { value.proofs[0] = null; },
    value => { delete value.runs[0]; }, value => { delete value.proofs[0]; },
    value => { value.proofs[3].artifacts[0] = null; },
    value => { value.proofs[0].artifacts[0].workflow_run = null; },
    value => { value.proofs[0].jobs[0].steps.push(null); },
  ]);
});
