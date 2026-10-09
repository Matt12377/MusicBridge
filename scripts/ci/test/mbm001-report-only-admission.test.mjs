import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { locateMobilePairingReportTask, classifyMobilePairingReportChanges, validateMobilePairingParentCi,
  locateMobileReportTask, classifyMobileReportChanges, validateMobileParentCi, inspectReportOnly } from '../report-only-admission.mjs';
import { validateOfflineArguments } from '../verify-mbrs001-offline.mjs';

// Git仓库、平台API和旧账都是明确合成输入；这里只验证报告准入，不证明软件/App/对端/Owner验收。
const task = 'MBM-001', parent = 'a'.repeat(40), base = 'c6c4745dfc7fe4242b8a2682798e00605649b12e';
const branch = 'codex/mbm-001-pairing-readonly-library';
const scope = 'docs/postrust/MBM-001/EXECUTION_SCOPE.json';
const authority = 'mobilePairingReadonlyLibrary';
const report = 'reports/MBM-001_RESULT.md';
const evidence = 'docs/postrust/MBM-001/evidence/source-ci.json';
const clone = value => structuredClone(value);
const change = name => ({ path: name, status: 'M', oldMode: '100644', newMode: '100644' });

function data() {
  const row = { id: task, title: '配对与只读曲库', status: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING', scope_ref: scope,
    base_report_sha: base, software: 'FINITE_SOFTWARE_PASS', production_app: 'FINITE_SYNTHETIC_APP_PASS',
    paired_contract: 'PEER_FINAL_REPORT_PENDING', real_service_device_audio: 'NOT_RUN', owner_acceptance: 'NOT_RUN',
    owner_repeated_approval_required: false, scheduled_after: 'MBM-000', acceptance_ref: 'docs/postrust/MBM-001/MOBILE_ACCEPTANCE.json' };
  const mobile = [{ id: 'MBM-000', status: 'SOFTWARE_DELIVERY_SEALED', report_commit: base }, clone(row),
    ...['MBM-002', 'MBM-003', 'MBM-004'].map(id => ({ id, status: 'NOT_STARTED', software: 'NOT_RUN', owner_acceptance: 'NOT_RUN' }))];
  const beforeStatus = { currentPostRustTask: 'MBRS-013',
    old013: { task: 'MBRS-013', originalEight: 'PARTIAL', live: 'NOT_RUN', owner: 'NOT_RUN' },
    mobileContractAdoption: { task: 'MBM-000', state: 'SOFTWARE_DELIVERY_SEALED', reportCommit: base, realServiceDeviceAudioOwner: 'NOT_RUN' },
    [authority]: { task, state: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING', branch, baseSha: base, scope,
      implementationCommit: null, reportCommit: null, software: 'FINITE_SOFTWARE_PASS', productionApp: 'FINITE_SYNTHETIC_APP_PASS',
      peerAdoption: 'PEER_FINAL_REPORT_PENDING', pairedAdoptionComplete: false, realServiceDeviceAudioOwner: 'NOT_RUN',
      ownerRepeatedApprovalRequired: false, sourceFilesWrite: false, defaultCore: 'NODE', optionalRustReadonly: 'OFF',
      sqliteWriter: 'EXISTING_DATASET_OWNER_ONLY', newMobileHttpsDefault: 'OFF',
      canonical: 'packages/contracts/mobile/openapi.json', canonicalSha256: 'd'.repeat(64),
      gateBudgets: { stageTimeoutMs: 120000, totalTimeoutMs: 420000 }, nextTask: 'MBM-002',
      iosSourceSha: '9'.repeat(40), iosFinalDelivery: 'PENDING_NOT_COORDINATOR_MESSAGE' },
    mobileFrontloading20261008: { currentTask: task, nextTask: 'MBM-002', state: 'SOURCE_SOFTWARE_PASS_REPORT_PENDING',
      originalTasks: 18, originalAcceptanceCases: 156, effectiveTasks: 17, effectiveAcceptanceCases: 150,
      ownerRepeatedApprovalRequired: false, mobileTasks: clone(mobile) } };
  const beforePlan = { execution_schedule: { current_task: task, current_task_scope_ref: scope,
    predecessor_final_report: base, remaining_sequence: [task, 'MBM-002', 'MBM-003', 'MBM-004', 'MBRS-016', 'MBRS-017'] },
    mobile_tasks: clone(mobile), tasks: Array.from({ length: 18 }, (_, index) => ({ id: 'MBRS-' + String(index).padStart(3, '0'),
      status: index === 15 ? 'CANCELLED' : 'PARTIAL', depends_on: [], goal: '合成原任务，不能由移动报告修改' })),
    acceptance_cases: Array.from({ length: 156 }, (_, index) => ({ id: '原AT-' + index,
      task: index < 8 ? 'MBRS-013' : index < 14 ? 'MBRS-015' : 'MBRS-002',
      software_status: index >= 8 && index < 14 ? 'N_A' : 'PARTIAL', live_status: index >= 8 && index < 14 ? 'N_A' : 'NOT_RUN',
      owner_status: index >= 8 && index < 14 ? 'N_A' : 'NOT_RUN', requirement: '合成原要求，不能放宽', evidence_refs: [] })) };
  const afterStatus = clone(beforeStatus), afterPlan = clone(beforePlan);
  afterStatus[authority].implementationCommit = parent;
  afterStatus[authority].report = report;
  afterStatus[authority].evidence = [evidence, report];
  for (const value of [afterStatus.mobileFrontloading20261008.mobileTasks[1], afterPlan.mobile_tasks[1]]) {
    value.implementation_commit = parent; value.report_path = report; value.evidence_refs = [evidence, report];
  }
  return { task, parent, beforeStatus, afterStatus, beforePlan, afterPlan,
    changes: [{ ...change(report), status: 'A', oldMode: '000000' }, change('project/STATUS.json'), change('project/POSTRUST_PLAN.json')] };
}
function rejectEdits(edits) {
  for (const edit of edits) {
    const value = data(); edit(value);
    assert.equal(classifyMobilePairingReportChanges(value), false);
  }
}

test('001报告：独立authority、lane和schedule定位，精确父Source记账准入', () => {
  const value = data();
  assert.equal(locateMobilePairingReportTask(value.beforeStatus, value.beforePlan), task);
  assert.equal(locateMobilePairingReportTask(value.afterStatus, value.afterPlan), task);
  assert.equal(classifyMobilePairingReportChanges(value), true);
  assert.equal(value.beforePlan.tasks.length, 18); assert.equal(value.beforePlan.acceptance_cases.length, 156);
});
test('001报告：缺失、重复、错域、scope、分支或真实前驱基线拒绝', () => {
  rejectEdits([
    value => { delete value.afterStatus[authority]; },
    value => { value.afterStatus.other001 = clone(value.afterStatus[authority]); },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks.push(clone(value.afterPlan.mobile_tasks[1])); },
    value => { value.afterPlan.mobile_tasks.push(clone(value.afterPlan.mobile_tasks[1])); },
    value => { value.beforeStatus.mobileFrontloading20261008.currentTask = 'MBM-000'; },
    value => { value.afterPlan.execution_schedule.current_task = 'MBM-002'; },
    value => { value.afterStatus[authority].branch = 'codex/other'; },
    value => { value.afterStatus[authority].baseSha = parent; },
    value => { value.afterStatus[authority].scope = 'docs/other.json'; },
    value => { value.afterPlan.execution_schedule.current_task_scope_ref = 'docs/other.json'; },
    value => { value.afterPlan.execution_schedule.predecessor_final_report = parent; },
    value => { value.afterPlan.mobile_tasks[1].base_report_sha = parent; },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks[1].scope_ref = 'docs/other.json'; },
  ]);
  const value = data();
  for (const status of [value.beforeStatus, value.afterStatus]) status[authority].baseSha = parent;
  for (const plan of [value.beforePlan, value.afterPlan]) plan.execution_schedule.predecessor_final_report = parent;
  assert.equal(classifyMobilePairingReportChanges(value), false);
});
test('001报告：旧000定位、分类与父CI函数继续拒绝001', () => {
  const value = data();
  assert.equal(locateMobileReportTask(value.afterStatus, value.afterPlan), null);
  assert.equal(classifyMobileReportChanges(value), false);
  assert.equal(validateMobileParentCi(ciData()), false);
});
test('001报告：authority和双份task行必须同时绑定精确父Source', () => {
  rejectEdits([
    value => { value.parent = 'unknown'; },
    value => { value.afterStatus[authority].implementationCommit = base; },
    value => { delete value.afterPlan.mobile_tasks[1].implementation_commit; },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks[1].implementation_commit = base; },
    value => { value.afterPlan.mobile_tasks[1].report_path = 'reports/MBM-001_OTHER.md'; },
    value => { value.afterStatus.mobileFrontloading20261008.mobileTasks[1].evidence_refs.push('仅一侧的新材料'); },
  ]);
});
test('001报告：软件、App、对端、真实层、Owner和当前状态不得在R升层', () => {
  for (const field of ['state', 'software', 'productionApp', 'peerAdoption', 'pairedAdoptionComplete',
    'realServiceDeviceAudioOwner', 'iosSourceSha', 'iosFinalDelivery']) {
    const value = data(); value.afterStatus[authority][field] = 'PASS';
    assert.equal(classifyMobilePairingReportChanges(value), false, field);
  }
  for (const field of ['status', 'software', 'production_app', 'paired_contract', 'real_service_device_audio', 'owner_acceptance']) {
    const value = data();
    value.afterPlan.mobile_tasks[1][field] = 'PASS'; value.afterStatus.mobileFrontloading20261008.mobileTasks[1][field] = 'PASS';
    assert.equal(classifyMobilePairingReportChanges(value), false, field);
  }
});
test('001报告：权限、默认OFF、预算、canonical、未知字段和下一任务冻结', () => {
  for (const field of ['ownerRepeatedApprovalRequired', 'sourceFilesWrite', 'defaultCore', 'optionalRustReadonly',
    'sqliteWriter', 'newMobileHttpsDefault', 'canonical', 'canonicalSha256', 'gateBudgets', 'nextTask', 'unknownPermission']) {
    const value = data(); value.afterStatus[authority][field] = '新值';
    assert.equal(classifyMobilePairingReportChanges(value), false, field);
  }
  rejectEdits([
    value => { value.afterStatus.mobileFrontloading20261008.state = 'COMPLETE'; },
    value => { value.afterStatus.mobileFrontloading20261008.nextTask = 'MBM-004'; },
    value => { value.afterPlan.execution_schedule.remaining_sequence = ['MBM-002']; },
  ]);
});
test('001报告：原18/156、有效17/150、013八PARTIAL、015六N_A和其它移动任务逐值不变', () => {
  rejectEdits([
    value => { value.afterStatus.currentPostRustTask = 'MBRS-016'; },
    value => { value.afterStatus.old013.originalEight = 'PASS'; },
    value => { value.afterStatus.mobileContractAdoption.realServiceDeviceAudioOwner = 'PASS'; },
    ...['originalTasks', 'originalAcceptanceCases', 'effectiveTasks', 'effectiveAcceptanceCases'].map(field =>
      value => { value.afterStatus.mobileFrontloading20261008[field]++; }),
    value => { value.afterPlan.tasks[13].status = 'PASS'; },
    value => { value.afterPlan.tasks[15].status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[7].software_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[7].live_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[7].owner_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[8].software_status = 'PASS'; },
    value => { value.afterPlan.acceptance_cases[0].evidence_refs.push('原AT也不许可借R追加'); },
    value => { value.afterPlan.acceptance_cases[155].requirement = '放宽'; },
    value => { value.afterPlan.tasks[1].depends_on = ['MBM-001']; },
    value => { value.afterPlan.mobile_tasks[2].status = 'IN_PROGRESS'; value.afterStatus.mobileFrontloading20261008.mobileTasks[2].status = 'IN_PROGRESS'; },
  ]);
});
test('001报告：只允许本域报告和evidence文档，拒产品、冻结输入、跨域和非普通文件', () => {
  const value = data(); value.changes.push({ ...change(evidence), status: 'A', oldMode: '000000' },
    change('project/POSTRUST_TODO.md'), change('project/POSTRUST_PROGRESS.md'));
  assert.equal(classifyMobilePairingReportChanges(value), true);
  for (const name of ['packages/bridge-core/src/mobile/auth-service.ts', 'packages/contracts/mobile/openapi.json',
    'packages/contracts/mobile/fixtures/manifest.json', 'pnpm-lock.yaml', '.github/workflows/verify.yml',
    'scripts/ci/report-only-admission.mjs', 'docs/postrust/MBM-001/EXECUTION_SCOPE.json',
    'docs/postrust/MBM-001/MOBILE_ACCEPTANCE.json', 'docs/postrust/MBM-001/TEST_SCOPE.json',
    'tasks/MBM-001_PAIRING_READONLY_LIBRARY.md', 'reports/MBM-000_RESULT.md', 'reports/MBRS-013_RESULT.md',
    'docs/postrust/MBM-002/evidence/source.json', 'reports/MBM-001_RESULT.md\n', 'docs/postrust/MBM-001/evidence/../scope.json']) {
    const invalid = data(); invalid.changes.push(change(name));
    assert.equal(classifyMobilePairingReportChanges(invalid), false, name);
  }
  rejectEdits([
    value => { value.changes.shift(); }, value => { value.changes = []; },
    value => { value.changes[0].status = 'D'; }, value => { value.changes[0].status = 'R'; },
    value => { value.changes[0].newMode = '120000'; }, value => { value.changes[0].newMode = '100755'; },
    value => { value.changes[0].status = 'M'; value.changes[0].oldMode = '120000'; },
    value => { value.changes[0].oldMode = '100644'; }, value => { value.changes.push(clone(value.changes[0])); },
  ]);
});

const workflowPaths = ['verify', 'security', 'rust-core', 'electron-e2e'].map(name => '.github/workflows/' + name + '.yml');
const gateNames = ['MBRS013 同内容位置迁移与具体清理 Gate', 'MBM000 移动合同双端采纳 Gate', 'MBM001 配对与只读曲库 Gate'];
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
  for (const edit of edits) { const value = ciData(); edit(value); assert.equal(validateMobilePairingParentCi(value), false); }
}
test('001报告CI：首次同Source四workflow六job，真实2/1/2/1分布及原三Gate成功', () => {
  const value = ciData();
  assert.deepEqual(value.proofs.map(proof => proof.jobs.length), [2, 1, 2, 1]);
  assert.equal(value.proofs.flatMap(proof => proof.artifacts).length, 5);
  assert.equal(validateMobilePairingParentCi(value), true);
});
test('001报告CI：013/000/001 Gate缺失、跳过、失败、未终态、重复或错producer拒绝', () => {
  for (const name of gateNames) {
    rejectCi([
      value => { value.proofs[0].jobs[0].steps = value.proofs[0].jobs[0].steps.filter(step => step.name !== name); },
      ...['skipped', 'failure', 'cancelled', null].map(conclusion => value => {
        value.proofs[0].jobs[0].steps.find(step => step.name === name).conclusion = conclusion;
      }),
      value => { value.proofs[0].jobs[0].steps.find(step => step.name === name).status = 'in_progress'; },
      value => { value.proofs[0].jobs[0].steps.push(clone(value.proofs[0].jobs[0].steps.find(step => step.name === name))); },
      value => { const job = value.proofs[0].jobs[0], step = job.steps.find(entry => entry.name === name);
        job.steps = job.steps.filter(entry => entry !== step); value.proofs[0].jobs[1].steps.push(step); },
    ]);
  }
});
test('001报告CI：真实producer步骤和4/6身份闭集不许以旧1/1/2/2或重复job代替', () => {
  rejectCi([
    value => { value.proofs[0].jobs.pop(); value.proofs[3].jobs.push(clone(value.proofs[3].jobs[0])); },
    value => { value.runs.push(clone(value.runs[0])); }, value => { value.proofs.push(clone(value.proofs[0])); },
    value => { value.proofs[2].jobs.pop(); }, value => { value.proofs[3].jobs.push(clone(value.proofs[3].jobs[0])); },
    value => { value.proofs[1].jobs[0].id = value.proofs[0].jobs[0].id; },
    value => { value.runs[1].id = value.runs[0].id; }, value => { value.proofs[0].runId = 999; },
    value => { value.proofs[0].jobs[1].steps[0].status = 'in_progress'; },
    value => { value.proofs[0].jobs[0].steps.push(value.proofs[0].jobs[1].steps.pop()); },
    value => { value.proofs[1].jobs[0].steps[0].conclusion = 'skipped'; },
    value => { value.proofs[2].jobs[1].steps[0].status = 'in_progress'; },
    value => { value.proofs[3].jobs[0].steps.pop(); },
    value => { value.proofs[0].jobs[0].steps = null; }, value => { value.proofs[0].jobs[0] = null; },
    value => { value.runs[0] = null; }, value => { value.proofs[0] = null; },
  ]);
});
test('001报告CI：Source、固定分支、仓库、push、attempt1及所有成功终态逐项绑定', () => {
  rejectCi([
    value => { value.task = 'MBM-000'; }, value => { value.parent = base; }, value => { value.branch = 'codex/other'; },
    value => { value.repositoryId = 100; }, value => { value.runs[0].head_sha = base; },
    value => { value.runs[0].head_branch = 'codex/other'; }, value => { value.runs[0].head_repository.id = 100; },
    value => { value.runs[0].event = 'workflow_dispatch'; }, value => { value.runs[0].run_attempt = 2; },
    value => { value.runs[0].status = 'in_progress'; }, value => { value.runs[0].conclusion = null; },
    value => { value.proofs[0].jobs[0].head_sha = base; }, value => { value.proofs[0].jobs[0].run_id = 999; },
    value => { value.proofs[0].jobs[0].conclusion = 'failure'; }, value => { value.proofs[1].jobs[0].status = 'queued'; },
    value => { value.now = NaN; },
  ]);
});
test('001报告CI：五平台制品digest、expiry和Source/run/repository绑定完整且不读取内容', () => {
  rejectCi([
    value => { value.proofs[0].artifacts = []; }, value => { value.proofs[0].artifacts[0].digest = null; },
    value => { value.proofs[0].artifacts[0].digest = 'sha256:unknown'; },
    value => { value.proofs[0].artifacts[0].expired = true; }, value => { value.proofs[0].artifacts[0].expires_at = 'invalid'; },
    value => { value.proofs[0].artifacts[0].expires_at = new Date(value.now).toISOString(); },
    value => { value.proofs[0].artifacts[0].workflow_run.head_sha = base; },
    value => { value.proofs[0].artifacts[0].workflow_run.id = 999; },
    value => { value.proofs[0].artifacts[0].workflow_run.repository_id = 100; },
    value => { value.proofs[3].artifacts[1].workflow_run.head_repository_id = 100; },
    value => { value.proofs[2].artifacts[1].name = value.proofs[2].artifacts[0].name; },
    value => { value.proofs[3].artifacts[0].id = value.proofs[0].artifacts[0].id; },
    value => { value.proofs[0].artifacts.push(clone(value.proofs[0].artifacts[0])); },
  ]);
});

function ownedGit(t) {
  assert.equal(typeof process.env.TMPDIR, 'string');
  const storage = validateOfflineArguments(['--output-root=' + path.join(process.env.TMPDIR, 'mbm001-report-only-' + randomUUID())], process.env);
  const directory = realpathSync(mkdtempSync(path.join(storage.temporary, 'mbm001-report-only-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-user-config'),
      GIT_AUTHOR_NAME: '合成准入测试', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: '合成准入测试', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' } }).trim();
  git(['init', '-b', branch]); git(['config', 'commit.gpgsign', 'false']);
  for (const name of ['project', 'reports', 'packages/bridge-core/src/mobile']) mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
  const value = data(), write = (name, content) => writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  write('project/STATUS.json', JSON.stringify(value.beforeStatus)); write('project/POSTRUST_PLAN.json', JSON.stringify(value.beforePlan));
  write('packages/bridge-core/src/mobile/synthetic.ts', 'export const synthetic = 1;\n');
  git(['add', '.']); git(['commit', '-m', '合成001 Source，不是实际产品证明']);
  const source = git(['rev-parse', 'HEAD']);
  value.afterStatus[authority].implementationCommit = source;
  value.afterStatus.mobileFrontloading20261008.mobileTasks[1].implementation_commit = source;
  value.afterPlan.mobile_tasks[1].implementation_commit = source;
  write('project/STATUS.json', JSON.stringify(value.afterStatus)); write('project/POSTRUST_PLAN.json', JSON.stringify(value.afterPlan));
  write(report, '合成001报告，真实服务和Owner未验收。\n');
  git(['add', '.']); git(['commit', '-m', '合成001 R']);
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'push',
    GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'synthetic/repo', GITHUB_REF_NAME: branch,
    GITHUB_SHA: git(['rev-parse', 'HEAD']) };
  return { directory, git, value, write, source, env };
}
function apiFor(complete, calls = []) {
  return async route => {
    calls.push(route);
    if (route === '') return { id: 99, private: false, full_name: 'synthetic/repo' };
    if (route.startsWith('/actions/runs?')) return { total_count: complete.runs.length, workflow_runs: complete.runs };
    const id = Number(/\/runs\/(\d+)/u.exec(route)?.[1]), proof = complete.proofs.find(value => value.runId === id);
    if (!proof) throw new Error('合成API路由未声明。');
    if (route === '/actions/runs/' + id + '/attempts/1/jobs?per_page=100') return { total_count: proof.jobs.length, jobs: proof.jobs };
    if (route === '/actions/runs/' + id + '/artifacts?per_page=100') return { total_count: proof.artifacts.length, artifacts: proof.artifacts };
    throw new Error('准入只能读取原attempt1和制品元数据，不能下载ZIP。');
  };
}
test('001报告真实Git：单父R选择001，完整6job/5artifact只声明平台元数据', async t => {
  const fixture = ownedGit(t), calls = [], complete = ciData(fixture.source);
  const result = await inspectReportOnly(fixture.env, fixture.directory, apiFor(complete, calls));
  assert.equal(result.mode, 'report-only'); assert.equal(result.task, task);
  assert.equal(result.reportSha, fixture.env.GITHUB_SHA); assert.equal(result.parentSourceSha, fixture.source);
  assert.equal(result.productResultsReused, true); assert.equal(result.artifactContentDownloaded, false);
  assert.equal(result.evidenceScope, 'PUBLIC_PLATFORM_PRODUCER_AND_ARTIFACT_DIGEST_METADATA_NOT_CONTENT_VALIDATION');
  assert.equal(result.workflows.length, 4); assert.equal(result.workflows.flatMap(value => value.jobIds).length, 6);
  assert.equal(result.workflows.flatMap(value => value.artifacts).length, 5);
  assert.equal(calls.filter(route => route.includes('/attempts/1/jobs?')).length, 4);
  assert.equal(calls.filter(route => route.includes('/artifacts?')).length, 3);
  assert.equal(calls.length, 9);
});
test('001报告真实Git：升层或产品叶变化先拒绝，不能降级借旧013/000定位', async t => {
  const fixture = ownedGit(t);
  let calls = 0;
  fixture.value.afterStatus[authority].pairedAdoptionComplete = true;
  fixture.write('project/STATUS.json', JSON.stringify(fixture.value.afterStatus));
  fixture.git(['add', 'project/STATUS.json']); fixture.git(['commit', '--amend', '--no-edit']);
  fixture.env.GITHUB_SHA = fixture.git(['rev-parse', 'HEAD']);
  const elevated = await inspectReportOnly(fixture.env, fixture.directory, async () => { calls++; return {}; });
  assert.equal(elevated.mode, 'full'); assert.equal(elevated.reason, 'SOURCE_SCOPE_OR_AUTHORITY_CHANGED'); assert.equal(calls, 0);
  fixture.value.afterStatus[authority].pairedAdoptionComplete = false;
  fixture.write('project/STATUS.json', JSON.stringify(fixture.value.afterStatus));
  fixture.write('packages/bridge-core/src/mobile/synthetic.ts', 'export const synthetic = 2;\n');
  fixture.git(['add', '.']); fixture.git(['commit', '--amend', '--no-edit']); fixture.env.GITHUB_SHA = fixture.git(['rev-parse', 'HEAD']);
  const changed = await inspectReportOnly(fixture.env, fixture.directory, async () => { calls++; return {}; });
  assert.equal(changed.mode, 'full'); assert.equal(changed.reason, 'SOURCE_SCOPE_OR_AUTHORITY_CHANGED'); assert.equal(calls, 0);
});
test('001报告真实Git：父CI未完成、缺自己的Gate或API列表不完整均回退完整验证', async t => {
  const fixture = ownedGit(t);
  for (const edit of [value => { value.runs[0].status = 'in_progress'; value.runs[0].conclusion = null; },
    value => { value.proofs[0].jobs[0].steps.at(-1).conclusion = 'skipped'; },
    value => { value.runs[0].run_attempt = 2; }]) {
    const complete = ciData(fixture.source); edit(complete);
    const result = await inspectReportOnly(fixture.env, fixture.directory, apiFor(complete));
    assert.equal(result.mode, 'full'); assert.equal(result.reason, 'PARENT_PRODUCT_GATE_NOT_PROVEN');
  }
  const complete = ciData(fixture.source), api = apiFor(complete);
  const incomplete = await inspectReportOnly(fixture.env, fixture.directory, async route => {
    const value = await api(route); return route.endsWith('/attempts/1/jobs?per_page=100') ? { ...value, total_count: value.total_count + 1 } : value;
  });
  assert.equal(incomplete.mode, 'full'); assert.equal(incomplete.reason, 'JOB_LIST_INCOMPLETE');
  const unavailable = await inspectReportOnly(fixture.env, fixture.directory, async () => { throw new Error('合成API拒绝。'); });
  assert.equal(unavailable.mode, 'full'); assert.equal(unavailable.reason, 'UNKNOWN_IDENTITY_OR_API_STATE');
});
test('001报告真实Git：dirty或多父R不得读取producer，普通会话也不访问API', async t => {
  const fixture = ownedGit(t); let calls = 0;
  fixture.write(report, '尚未提交的合成变化。\n');
  const dirty = await inspectReportOnly(fixture.env, fixture.directory, async () => { calls++; return {}; });
  assert.equal(dirty.mode, 'full'); assert.equal(dirty.reason, 'CHECKOUT_NOT_PINNED_CLEAN'); assert.equal(calls, 0);
  fixture.write(report, '合成001报告，真实服务和Owner未验收。\n');
  const oldReport = fixture.env.GITHUB_SHA, tree = fixture.git(['rev-parse', 'HEAD^{tree}']);
  const merged = fixture.git(['commit-tree', tree, '-p', oldReport, '-p', fixture.source, '-m', '合成双父R，必须拒绝']);
  fixture.git(['update-ref', 'HEAD', merged]); fixture.env.GITHUB_SHA = merged;
  const multi = await inspectReportOnly(fixture.env, fixture.directory, async () => { calls++; return {}; });
  assert.equal(multi.mode, 'full'); assert.equal(multi.reason, 'NOT_SINGLE_PARENT'); assert.equal(calls, 0);
  const local = await inspectReportOnly({}, fixture.directory, async () => { calls++; return {}; });
  assert.equal(local.mode, 'full'); assert.equal(local.reason, 'NOT_PUBLIC_HOSTED_PUSH_CONTEXT'); assert.equal(calls, 0);
});
