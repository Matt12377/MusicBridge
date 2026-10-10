import test from 'node:test';
import assert from 'node:assert/strict';
import { locateMobileDsdReportTask, classifyMobileDsdReportChanges,
  validateMobileDsdParentCi } from '../report-only-mbm003.mjs';
import { locateMobilePlaybackReportTask, classifyMobilePlaybackReportChanges,
  validateMobilePlaybackParentCi } from '../report-only-mbm002.mjs';

// 全部账本与GitHub producer为合成数据；不运行Git/API/产品，也不读取或声称验证ZIP内容。
const task = 'MBM-003', parent = 'a'.repeat(40), base = 'b1a8de728086e7994bb69d7dee10782f646886dd';
const branch = 'codex/mbm-003-lossless-dsd-transport';
const scope = 'docs/postrust/MBM-003/EXECUTION_SCOPE.json', authority = 'mobileLosslessDsdTransport';
const report = 'reports/MBM-003_RESULT.md', evidence = 'docs/postrust/MBM-003/evidence/source-ci.json';
const workflowPaths = ['verify', 'security', 'rust-core', 'electron-e2e'].map(name => '.github/workflows/' + name + '.yml');
const gateNames = ['MBM003 无损与DSD传输软件 Gate', 'MBM003 精确前序软件证据复用'];
const oldGateNames = ['MBRS013 同内容位置迁移与具体清理 Gate', 'MBM000 移动合同双端采纳 Gate',
  'MBM001 配对与只读曲库 Gate', 'MBM002 手机资源播放 Gate'];
const clone = value => structuredClone(value);
const change = name => ({ path: name, status: 'M', oldMode: '100644', newMode: '100644' });
const statusRow = status => status.mobileFrontloading20261008.mobileTasks.find(row => row.id === task);
const planRow = plan => plan.mobile_tasks.find(row => row.id === task);

function data() {
  const row = { id: task, title: 'FLAC无损与DSD传输', status: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING',
    scope_ref: scope, base_report_sha: base, branch, scheduled_after: 'MBM-002',
    software: 'FINITE_SOFTWARE_PASS', production_app: 'FINITE_OWNED_APP_PASS',
    real_service_device_audio: 'NOT_RUN_NEW003', owner_acceptance: 'NOT_RUN_NEW003',
    owner_repeated_approval_required: false, paired_contract_frozen: true };
  const mobile = ['MBM-000', 'MBM-001', 'MBM-002'].map(id => ({
    id, status: 'SOFTWARE_DELIVERY_SEALED', report_commit: base, real_service_device_audio: 'PRESERVED_PRIOR_BOUNDARY',
    evidence_refs: ['docs/postrust/' + id + '/evidence/source-ci.json'] }));
  mobile.push(clone(row), { id: 'MBM-004', status: 'NOT_STARTED', software: 'NOT_RUN', owner_acceptance: 'NOT_RUN' });
  const beforeStatus = { currentPostRustTask: 'MBRS-013',
    old013: { task: 'MBRS-013', originalEight: 'PARTIAL', live: 'NOT_RUN', owner: 'NOT_RUN' },
    mobileContractAdoption: { task: 'MBM-000', state: 'SOFTWARE_DELIVERY_SEALED', paired: 'PRESERVED_PRIOR_BOUNDARY' },
    mobilePairingReadonlyLibrary: { task: 'MBM-001', state: 'SOFTWARE_DELIVERY_SEALED', reportCommit: base,
      evidence: ['docs/postrust/MBM-001/evidence/source-ci.json'] },
    mobilePlaybackResources: { task: 'MBM-002', state: 'SOFTWARE_DELIVERY_SEALED', reportCommit: base,
      actualDeviceOwnerCarryover: 'PRESERVED_PRIOR_BOUNDARY', evidence: ['docs/postrust/MBM-002/evidence/source-ci.json'] },
    [authority]: { task, state: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING', branch, baseSha: base, scope,
      implementationCommit: null, reportCommit: null, software: 'FINITE_SOFTWARE_PASS', productionApp: 'FINITE_OWNED_APP_PASS',
      physicalDeviceAudio: 'NOT_RUN_NEW003', ownerAcceptance: 'NOT_RUN_NEW003',
      pairedContractFrozen: true, actualPairedAdoption: { bytes: 1959, sha256: 'd'.repeat(64) },
      ownerRepeatedApprovalRequired: false, sourceFilesWrite: false, defaultCore: 'NODE', optionalRustReadonly: 'OFF',
      sqliteWriter: 'EXISTING_DATASET_OWNER_ONLY', controlAndOriginalStream: 'LOOPBACK',
      canonical: 'packages/contracts/mobile/openapi.json', canonicalSha256: 'd'.repeat(64), nextTask: 'MBM-004',
      gateBudgets: { stageTimeoutMs: 180000, totalTimeoutMs: 480000 },
      cacheBudgets: { jobs: 1, waiting: 4, entryBytes: 2147483648, totalBytes: 4294967296, preparationMs: 240000 },
      iosSourceSha: '9'.repeat(40), iosFinalDelivery: 'PRESERVED_PEER_RECEIPT' },
    mobileFrontloading20261008: { currentTask: task, nextTask: 'MBM-004', state: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING',
      originalTasks: 18, originalAcceptanceCases: 156, effectiveTasks: 17, effectiveAcceptanceCases: 150,
      ownerRepeatedApprovalRequired: false, mobileTasks: clone(mobile) } };
  const beforePlan = { execution_schedule: { current_task: task, current_task_scope_ref: scope,
    predecessor_final_report: base, remaining_sequence: [task, 'MBM-004', 'MBRS-016', 'MBRS-017'] },
    mobile_tasks: clone(mobile), tasks: Array.from({ length: 18 }, (_, index) => ({ id: 'MBRS-' + String(index).padStart(3, '0'),
      status: index === 15 ? 'CANCELLED' : 'PARTIAL', depends_on: [], goal: '合成原任务，不能由移动报告修改' })),
    acceptance_cases: Array.from({ length: 156 }, (_, index) => ({ id: '原AT-' + index,
      task: index < 8 ? 'MBRS-013' : index < 14 ? 'MBRS-015' : 'MBRS-002',
      software_status: index >= 8 && index < 14 ? 'N_A' : 'PARTIAL', live_status: index >= 8 && index < 14 ? 'N_A' : 'NOT_RUN',
      owner_status: index >= 8 && index < 14 ? 'N_A' : 'NOT_RUN', requirement: '合成原要求，不能放宽', evidence_refs: [] })),
    mobile_acceptance_cases: Array.from({ length: 9 }, (_, index) => ({ id: 'MBM002-合成AT-' + index,
      task: 'MBM-002', software_status: 'PARTIAL', real_status: 'PRESERVED_PRIOR_BOUNDARY', owner_status: 'PRESERVED_PRIOR_BOUNDARY' })) };
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
  for (const edit of edits) { const value = data(); edit(value); assert.equal(classifyMobileDsdReportChanges(value), false); }
}

test('003报告：唯一authority/lane/schedule/双表与精确Source报告记账', () => {
  const value = data();
  assert.equal(locateMobileDsdReportTask(value.beforeStatus, value.beforePlan), task);
  assert.equal(locateMobileDsdReportTask(value.afterStatus, value.afterPlan), task);
  Object.assign(value.afterStatus[authority], { implementationCommitResolution: 'EXACT_PARENT_SOURCE', reportCommit: 'RESOLVE_HEAD',
    reportCommitResolution: 'RESOLVE_FINAL_REPORT_HEAD', push: { source: '合成平台记录' }, ci: { source: evidence },
    updatedAt: '2026-10-10T00:00:00Z', updatedAtUTC: '2026-10-10T00:00:00Z',
    finalDeliveryReceipt: 'PRIVATE_EXTERNAL_AFTER_R', nextBranchBaseline: 'RESOLVE_FINAL_R' });
  for (const row of [statusRow(value.afterStatus), planRow(value.afterPlan)]) Object.assign(row, {
    implementation_commit_resolution: 'EXACT_PARENT_SOURCE', report_commit: 'RESOLVE_HEAD',
    report_commit_resolution: 'RESOLVE_FINAL_REPORT_HEAD', terminal_ci_receipt: { source: evidence } });
  assert.equal(classifyMobileDsdReportChanges(value), true);
  assert.equal(value.beforePlan.tasks.length, 18); assert.equal(value.beforePlan.acceptance_cases.length, 156);
});

test('003报告：重复或缺失定位、scope/branch/base及schedule错位拒绝', () => {
  rejectEdits([
    value => { delete value.afterStatus[authority]; },
    value => { value.afterStatus.other003 = clone(value.afterStatus[authority]); },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks.push(clone(planRow(value.afterPlan))); },
    value => { value.afterPlan.mobile_tasks.push(clone(planRow(value.afterPlan))); },
    value => { value.afterPlan.mobile_tasks = value.afterPlan.mobile_tasks.filter(row => row.id !== task); },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks = value.afterStatus.mobileFrontloading20261008.mobileTasks.filter(row => row.id !== task); },
    value => { value.beforeStatus.mobileFrontloading20261008.currentTask = 'MBM-002'; },
    value => { value.afterPlan.execution_schedule.current_task = 'MBM-004'; },
    value => { value.afterStatus[authority].branch = 'codex/other'; },
    value => { value.afterStatus[authority].baseSha = parent; },
    value => { value.afterStatus[authority].scope = 'docs/postrust/MBM-002/EXECUTION_SCOPE.json'; },
    value => { value.afterPlan.execution_schedule.current_task_scope_ref = 'docs/other.json'; },
    value => { value.afterPlan.execution_schedule.predecessor_final_report = parent; },
    value => { planRow(value.afterPlan).base_report_sha = parent; },
    value => { statusRow(value.afterStatus).scope_ref = 'docs/other.json'; },
    value => { planRow(value.afterPlan).branch = 'codex/other'; },
    value => { planRow(value.afterPlan).software = '不同Source状态'; },
  ]);
  const value = data();
  for (const status of [value.beforeStatus, value.afterStatus]) status[authority].baseSha = parent;
  for (const plan of [value.beforePlan, value.afterPlan]) plan.execution_schedule.predecessor_final_report = parent;
  assert.equal(locateMobileDsdReportTask(value.afterStatus, value.afterPlan), null);
});

test('003报告：authority及双表须绑定同一父Source与完整报告记账', () => {
  rejectEdits([
    value => { value.task = 'MBM-002'; }, value => { value.parent = 'unknown'; }, value => { value.parent += '\n'; },
    value => { value.afterStatus[authority].implementationCommit = base; },
    value => { delete planRow(value.afterPlan).implementation_commit; },
    value => { statusRow(value.afterStatus).implementation_commit = base; },
    value => { planRow(value.afterPlan).report_path = 'reports/MBM-003_OTHER.md'; },
    value => { statusRow(value.afterStatus).evidence_refs.push('仅单侧的新材料'); },
  ]);
});

test('003报告：软件/App/物理设备/Owner/对端采纳和资格不得在R升层', () => {
  for (const field of ['state', 'software', 'productionApp', 'physicalDeviceAudio', 'ownerAcceptance',
    'pairedContractFrozen', 'actualPairedAdoption', 'iosSourceSha', 'iosFinalDelivery']) {
    const value = data(); value.afterStatus[authority][field] = 'PASS';
    assert.equal(classifyMobileDsdReportChanges(value), false, field);
  }
  for (const field of ['status', 'software', 'production_app', 'real_service_device_audio',
    'owner_acceptance', 'validation_status', 'paired_contract_frozen']) {
    const value = data();
    for (const row of [statusRow(value.afterStatus), planRow(value.afterPlan)]) row[field] = 'PASS';
    assert.equal(classifyMobileDsdReportChanges(value), false, field);
  }
});

test('003报告：权限/预算/范围/Node唯一writer/旧OFF及canonical逐值冻结', () => {
  for (const field of ['ownerRepeatedApprovalRequired', 'sourceFilesWrite', 'defaultCore', 'optionalRustReadonly',
    'sqliteWriter', 'controlAndOriginalStream', 'canonical', 'canonicalSha256', 'gateBudgets',
    'cacheBudgets', 'scope', 'nextTask', 'unknownPermission']) {
    const value = data(); value.afterStatus[authority][field] = '新值';
    assert.equal(classifyMobileDsdReportChanges(value), false, field);
  }
  rejectEdits([
    value => { value.afterStatus[authority].cacheBudgets.preparationMs++; },
    value => { value.afterStatus.mobileFrontloading20261008.state = 'COMPLETE'; },
    value => { value.afterStatus.mobileFrontloading20261008.nextTask = 'MBRS-016'; },
    value => { value.afterPlan.execution_schedule.remaining_sequence = ['MBM-004']; },
    value => { for (const row of [statusRow(value.afterStatus), planRow(value.afterPlan)]) row.owner_repeated_approval_required = true; },
  ]);
});

test('003报告：原18/156与17/150、013八PARTIAL/015六N_A、002及后继不变', () => {
  rejectEdits([
    value => { value.afterStatus.currentPostRustTask = 'MBRS-016'; },
    value => { value.afterStatus.old013.originalEight = 'PASS'; },
    value => { value.afterStatus.mobileContractAdoption.paired = '新采纳'; },
    value => { value.afterStatus.mobilePairingReadonlyLibrary.evidence.push(evidence); },
    value => { value.afterStatus.mobilePlaybackResources.actualDeviceOwnerCarryover = '新验收'; },
    value => { value.afterStatus.mobilePlaybackResources.evidence.push(evidence); },
    ...['originalTasks', 'originalAcceptanceCases', 'effectiveTasks', 'effectiveAcceptanceCases'].map(field =>
      value => { value.afterStatus.mobileFrontloading20261008[field]++; }),
    value => { value.afterPlan.tasks[13].status = 'PASS'; },
    value => { value.afterPlan.tasks[15].status = 'PASS'; },
    value => { value.afterPlan.tasks[1].depends_on = ['MBM-003']; },
    value => { value.afterPlan.acceptance_cases[7].software_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[7].live_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[7].owner_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[8].software_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[0].evidence_refs.push(evidence); },
    value => { value.afterPlan.acceptance_cases[155].requirement = '放宽'; },
    value => { value.afterPlan.mobile_acceptance_cases[0].software_status = 'PASS'; },
    value => { value.afterPlan.tasks.pop(); }, value => { value.afterPlan.acceptance_cases.pop(); },
    ...['MBM-000', 'MBM-001', 'MBM-002', 'MBM-004'].map(id => value => {
      for (const rows of [value.afterPlan.mobile_tasks, value.afterStatus.mobileFrontloading20261008.mobileTasks])
        rows.find(row => row.id === id).status = 'IN_PROGRESS';
    }),
  ]);
});

test('003报告：仅本域reports/evidence与四metadata普通路径可准入', () => {
  const value = data();
  value.changes.push({ ...change(evidence), status: 'A', oldMode: '000000' },
    change('reports/MBM-003_EVIDENCE.json'), change('docs/postrust/MBM-003/evidence/software-boundary.md'),
    change('project/POSTRUST_TODO.md'), change('project/POSTRUST_PROGRESS.md'));
  assert.equal(classifyMobileDsdReportChanges(value), true);
  for (const name of ['packages/bridge-core/src/mobile/playback-service.ts', 'apps/desktop/src/main/mobile-media-response.ts',
    'packages/contracts/mobile/openapi.json', 'pnpm-lock.yaml', '.github/workflows/verify.yml',
    'scripts/ci/report-only-mbm003.mjs', 'docs/postrust/MBM-003/EXECUTION_SCOPE.json',
    'docs/postrust/MBM-003/CONTRACT_SEMANTICS.md', 'docs/postrust/MBM-003/TEST_SCOPE.json',
    'reports/MBM-002_RESULT.md', 'docs/postrust/MBM-002/evidence/source-ci.json',
    'docs/postrust/MBM-004/evidence/source-ci.json', '../reports/MBM-003_RESULT.md', '/reports/MBM-003_RESULT.md',
    'reports/MBM-003_result.md', 'reports/MBM-003_RESULT.md\n', 'reports/MBM-003_RESULT.md\r',
    'reports/MBM-003_RESULT.md\0', 'reports/MBM-003_RESULT.md\u2028', 'reports\\MBM-003_RESULT.md',
    'docs/postrust/MBM-003/evidence/../scope.json', 'docs/postrust/MBM-003/evidence/nested/result.json',
    'docs/postrust/MBM-003/evidence/source.json\n', 'project/STATUS.json\n']) {
    const invalid = data(); invalid.changes.push(change(name));
    assert.equal(classifyMobileDsdReportChanges(invalid), false, name);
  }
});

test('003报告：delete/rename/链接/执行位/重复路径和缺report拒绝', () => {
  rejectEdits([
    value => { value.changes.shift(); }, value => { value.changes = []; },
    ...['D', 'R', 'C', 'T', 'U'].map(status => value => { value.changes[0].status = status; }),
    value => { value.changes[0].newMode = '120000'; }, value => { value.changes[0].newMode = '100755'; },
    value => { value.changes[0].newMode = '160000'; },
    value => { value.changes[0].status = 'M'; value.changes[0].oldMode = '120000'; },
    value => { value.changes[0].status = 'M'; value.changes[0].oldMode = '100755'; },
    value => { value.changes[0].oldMode = '100644'; },
    value => { value.changes.push(clone(value.changes[0])); },
    value => { value.changes[0].path = 1; }, value => { value.changes[0] = null; }, value => { delete value.changes[0]; },
  ]);
});

test('003报告：缺失/空洞/非JSON字段fail-closed且键顺序不影响等值', () => {
  for (const input of [undefined, null, {}, [], 1]) assert.equal(classifyMobileDsdReportChanges(input), false);
  for (const input of [undefined, null, {}, [], 1]) assert.equal(locateMobileDsdReportTask(input, input), null);
  rejectEdits([
    value => { value.afterPlan = null; }, value => { value.beforeStatus = null; },
    value => { value.afterPlan.tasks = null; }, value => { value.afterPlan.acceptance_cases = {}; },
    value => { value.afterPlan.mobile_tasks = null; }, value => { value.changes = {}; },
    value => { delete value.afterPlan.tasks[0]; },
    value => { value.afterStatus[authority].cacheBudgets.jobs = NaN; },
    value => { value.afterStatus.extraDate = new Date('2026-10-10T00:00:00Z'); },
  ]);
  const value = data();
  value.afterStatus[authority].cacheBudgets = Object.fromEntries(Object.entries(value.afterStatus[authority].cacheBudgets).reverse());
  value.afterPlan = Object.fromEntries(Object.entries(value.afterPlan).reverse());
  assert.equal(classifyMobileDsdReportChanges(value), true);
});

function legacy002Data() {
  const value = data(), oldTask = 'MBM-002', oldBase = '8044d935e242d8647adc21445116fb49c9100e4a';
  const oldAuthority = 'mobilePlaybackResources', oldScope = 'docs/postrust/MBM-002/EXECUTION_SCOPE.json';
  const oldBranch = 'codex/mbm-002-phone-resource-playback', oldReport = 'reports/MBM-002_RESULT.md';
  value.task = oldTask;
  for (const status of [value.beforeStatus, value.afterStatus]) {
    status[oldAuthority] = { ...status[authority], task: oldTask, baseSha: oldBase, branch: oldBranch, scope: oldScope };
    if (status[oldAuthority].report) status[oldAuthority].report = oldReport;
    if (status[oldAuthority].evidence) status[oldAuthority].evidence = [oldReport];
    delete status[authority]; status.mobileFrontloading20261008.currentTask = oldTask;
    status.mobileFrontloading20261008.mobileTasks = status.mobileFrontloading20261008.mobileTasks.filter(row => row.id !== oldTask);
    const row = statusRow(status); Object.assign(row, { id: oldTask, base_report_sha: oldBase, branch: oldBranch, scope_ref: oldScope });
    if (row.report_path) row.report_path = oldReport;
    if (row.evidence_refs) row.evidence_refs = [oldReport];
  }
  for (const plan of [value.beforePlan, value.afterPlan]) {
    Object.assign(plan.execution_schedule, { current_task: oldTask, current_task_scope_ref: oldScope, predecessor_final_report: oldBase });
    plan.mobile_tasks = plan.mobile_tasks.filter(row => row.id !== oldTask);
    const row = planRow(plan); Object.assign(row, { id: oldTask, base_report_sha: oldBase, branch: oldBranch, scope_ref: oldScope });
    if (row.report_path) row.report_path = oldReport;
    if (row.evidence_refs) row.evidence_refs = [oldReport];
  }
  value.changes[0].path = oldReport;
  return value;
}

test('003独立接线：旧002合法报告/完整旧CI仍保持；旧准入器拒绝003', () => {
  const value = data();
  assert.equal(locateMobilePlaybackReportTask(value.afterStatus, value.afterPlan), null);
  assert.equal(classifyMobilePlaybackReportChanges(value), false);
  assert.equal(validateMobilePlaybackParentCi(ciData()), false);
  const old = legacy002Data();
  assert.equal(locateMobilePlaybackReportTask(old.afterStatus, old.afterPlan), 'MBM-002');
  assert.equal(classifyMobilePlaybackReportChanges(old), true);
  assert.equal(classifyMobileDsdReportChanges(old), false);
  const oldCi = ciData(); oldCi.task = 'MBM-002'; oldCi.branch = 'codex/mbm-002-phone-resource-playback';
  for (const run of oldCi.runs) run.head_branch = oldCi.branch;
  oldCi.proofs[0].jobs[0].steps = [oldCi.proofs[0].jobs[0].steps[0],
    ...oldGateNames.map(name => ({ name, status: 'completed', conclusion: 'success' }))];
  assert.equal(validateMobilePlaybackParentCi(oldCi), true);
  assert.equal(validateMobileDsdParentCi(oldCi), false);
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
  return { task, parent: source, repositoryId: 99, branch, runs, proofs, now: Date.parse('2026-10-10T00:00:00Z') };
}
function rejectCi(edits) {
  for (const edit of edits) { const value = ciData(); edit(value); assert.equal(validateMobileDsdParentCi(value), false); }
}

test('003报告CI：独立四workflow六job五artifact，不要求重跑旧Gate', () => {
  const value = ciData();
  assert.deepEqual(value.proofs.map(proof => proof.jobs.length), [2, 1, 2, 1]);
  assert.deepEqual(value.proofs.map(proof => proof.artifacts.length), [1, 0, 2, 2]);
  for (const name of oldGateNames) assert.equal(value.proofs[0].jobs[0].steps.some(step => step.name === name), false);
  assert.equal(validateMobileDsdParentCi(value), true);
});

test('003报告CI：新软件Gate和前序复用步骤须唯一成功且同属workspace job', () => {
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
  const value = ciData();
  value.proofs[0].jobs[0].steps = [value.proofs[0].jobs[0].steps[0],
    ...oldGateNames.map(name => ({ name, status: 'completed', conclusion: 'success' }))];
  assert.equal(validateMobileDsdParentCi(value), false);
});

test('003报告CI：原标准/安全/Rust双平台/Electron双步骤和2/1/2/1分布保持', () => {
  rejectCi([
    value => { value.proofs[0].jobs.pop(); value.proofs[3].jobs.push(clone(value.proofs[3].jobs[0])); },
    value => { value.proofs[2].jobs.pop(); }, value => { value.proofs[3].jobs.push(clone(value.proofs[3].jobs[0])); },
    value => { value.proofs[0].jobs[1].steps[0].status = 'in_progress'; },
    value => { value.proofs[0].jobs[0].steps.push(value.proofs[0].jobs[1].steps.pop()); },
    value => { value.proofs[1].jobs[0].steps[0].conclusion = 'skipped'; },
    value => { value.proofs[2].jobs[1].steps[0].status = 'in_progress'; },
    value => { value.proofs[3].jobs[0].steps.pop(); },
    value => { value.proofs[0].jobs[0].steps.push(clone(value.proofs[0].jobs[0].steps[0])); },
    value => { value.proofs[2].jobs[1].steps.push(clone(value.proofs[2].jobs[1].steps[0])); },
  ]);
});

test('003报告CI：always归档成功不能遮盖产品步骤或整job失败', () => {
  for (const index of [0, 1, 2, 3]) {
    const value = ciData();
    value.proofs[index].jobs[0].steps.push({ name: 'Upload artifact', status: 'completed', conclusion: 'success' });
    value.proofs[index].jobs[0].steps[0].conclusion = 'failure';
    assert.equal(validateMobileDsdParentCi(value), false);
  }
  rejectCi([
    value => { value.proofs[0].jobs[0].conclusion = 'failure'; },
    value => { value.runs[3].conclusion = 'cancelled'; },
    value => { value.proofs[3].jobs[0].status = 'in_progress'; },
  ]);
});

test('003报告CI：run/job/artifact及proof闭集唯一，重复/缺失/额外producer拒绝', () => {
  rejectCi([
    value => { value.runs.push(clone(value.runs[0])); }, value => { value.runs.pop(); },
    value => { value.proofs.push(clone(value.proofs[0])); }, value => { value.proofs.pop(); },
    value => { value.runs[1].id = value.runs[0].id; },
    value => { value.proofs[1].jobs[0].id = value.proofs[0].jobs[0].id; },
    value => { value.proofs[3].artifacts[0].id = value.proofs[0].artifacts[0].id; },
    value => { value.proofs[1].runId = value.proofs[0].runId; },
    value => { value.proofs[0].runId = 999; }, value => { value.runs[1].path = value.runs[0].path; },
    value => { value.proofs[0].artifacts.push(clone(value.proofs[0].artifacts[0])); },
    value => { value.proofs[1].artifacts.push(clone(value.proofs[0].artifacts[0])); },
  ]);
});

test('003报告CI：Source/branch/仓库/push/attempt1和自然成功终态逐项绑定', () => {
  rejectCi([
    value => { value.task = 'MBM-002'; }, value => { value.parent = base; }, value => { value.parent += '\n'; },
    value => { value.branch = 'codex/other'; }, value => { value.repositoryId = 100; },
    value => { value.runs[0].head_sha = base; }, value => { value.runs[0].head_branch = 'codex/other'; },
    value => { value.runs[0].repository.id = 100; }, value => { value.runs[0].head_repository.id = 100; },
    value => { value.runs[0].event = 'workflow_dispatch'; }, value => { value.runs[0].event = 'pull_request'; },
    value => { value.runs[0].run_attempt = 2; }, value => { value.runs[0].run_attempt = 0; },
    value => { value.runs[0].status = 'in_progress'; }, value => { value.runs[0].conclusion = null; },
    value => { value.runs[1].conclusion = 'cancelled'; },
    value => { value.proofs[0].jobs[0].head_sha = base; }, value => { value.proofs[0].jobs[0].run_id = 999; },
    value => { value.proofs[1].jobs[0].status = 'queued'; },
    value => { value.proofs[0].jobs[0].id = 0; }, value => { value.runs[0].id = 1.5; },
    value => { value.repositoryId = Number.MAX_SAFE_INTEGER + 1; }, value => { value.repositoryId = 0; },
    value => { value.now = NaN; }, value => { value.now = Infinity; }, value => { value.now = null; },
  ]);
});

test('003报告CI：五artifact的精确名称和producer归属不可交换或重复', () => {
  rejectCi([
    value => { value.proofs[2].artifacts[1].name = value.proofs[2].artifacts[0].name; },
    value => { value.proofs[3].artifacts[1].name = 'rust-host-compiled-' + base; },
    value => { value.proofs[0].artifacts[0].name += '\n'; },
    value => { value.proofs[2].artifacts[0].name = 'rust-core-windows-latest-' + parent; },
    value => { const left = value.proofs[0].artifacts[0], right = value.proofs[3].artifacts[0];
      [left.name, right.name] = [right.name, left.name]; },
    value => { const left = value.proofs[2].artifacts[0], right = value.proofs[3].artifacts[1];
      [left.name, right.name] = [right.name, left.name]; },
  ]);
});

test('003报告CI：平台digest/期限及artifact的Source/run/repository完整绑定', () => {
  rejectCi([
    value => { value.proofs[0].artifacts = []; }, value => { value.proofs[0].artifacts[0].digest = null; },
    value => { value.proofs[0].artifacts[0].digest = 'sha256:unknown'; },
    value => { value.proofs[0].artifacts[0].digest += '\n'; },
    value => { value.proofs[0].artifacts[0].digest = 'sha256:' + 'D'.repeat(64); },
    value => { value.proofs[0].artifacts[0].expired = true; }, value => { delete value.proofs[0].artifacts[0].expired; },
    value => { value.proofs[0].artifacts[0].expires_at = 'invalid'; },
    value => { value.proofs[0].artifacts[0].expires_at = new Date(value.now).toISOString(); },
    value => { value.proofs[0].artifacts[0].workflow_run.head_sha = base; },
    value => { value.proofs[0].artifacts[0].workflow_run.id = 999; },
    value => { value.proofs[0].artifacts[0].workflow_run.repository_id = 100; },
    value => { value.proofs[3].artifacts[1].workflow_run.head_repository_id = 100; },
    value => { value.proofs[2].artifacts[0].id = 0; },
  ]);
});

test('003报告CI：坏列表/空洞/null/缺步骤fail-closed且不抛内部错误', () => {
  for (const input of [undefined, null, {}, [], 1]) assert.equal(validateMobileDsdParentCi(input), false);
  rejectCi([
    value => { value.proofs[0].jobs[0].steps = null; }, value => { value.proofs[0].jobs[0] = null; },
    value => { value.runs[0] = null; }, value => { value.proofs[0] = null; },
    value => { delete value.runs[0]; }, value => { delete value.proofs[0]; },
    value => { delete value.proofs[0].jobs[0]; }, value => { delete value.proofs[0].jobs[0].steps[0]; },
    value => { delete value.proofs[3].artifacts[0]; }, value => { value.proofs[3].artifacts[0] = null; },
    value => { value.proofs[0].artifacts[0].workflow_run = null; },
    value => { value.proofs[0].jobs[0].steps.push(null); },
  ]);
});
