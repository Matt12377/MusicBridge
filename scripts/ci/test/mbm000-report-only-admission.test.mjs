import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateMobileReportTask, classifyMobileReportChanges, validateMobileParentCi,
  inspectReportOnly } from '../report-only-admission.mjs';

const parent = 'a'.repeat(40), base = 'b'.repeat(40), task = 'MBM-000';
const branch = 'codex/mbm-000-mobile-contracts';
const scope = 'docs/postrust/MBM-000/EXECUTION_SCOPE.json';
const copy = value => structuredClone(value);
const change = name => ({ path: name, status: 'M', oldMode: '100644', newMode: '100644' });

function data() {
  const row = { id: task, status: 'SOFTWARE_PASS', scope_ref: scope, base_report_sha: base,
    software: 'CONTRACT_GATE_PASS', paired_contract: 'PENDING_PEER_DELIVERY', owner_acceptance: 'NOT_RUN' };
  const beforeStatus = {
    currentPostRustTask: 'MBRS-013', original: { task: 'MBRS-013', software: 'SEALED', originalEight: 'PARTIAL' },
    mobileContractAdoption: { task, state: 'SOFTWARE_PASS', branch, baseSha: base, scope,
      implementationCommit: null, reportCommit: null, software: 'CONTRACT_GATE_PASS',
      productionApp: 'NOT_RUN', peerAdoption: 'PENDING', pairedAdoptionComplete: false,
      realServiceDeviceAudioOwner: 'NOT_RUN', ownerRepeatedApprovalRequired: false,
      canonical: 'packages/contracts/mobile/openapi.json', gateBudgets: { totalTimeoutMs: 360000 } },
    mobileFrontloading20261008: { currentTask: task, nextTask: 'MBM-001', state: 'SOFTWARE_PASS',
      mobileTasks: [copy(row), { id: 'MBM-001', status: 'NOT_STARTED' }] } };
  const beforePlan = {
    execution_schedule: { current_task: task, current_task_scope_ref: scope, predecessor_final_report: base },
    mobile_tasks: [copy(row), { id: 'MBM-001', status: 'NOT_STARTED' }],
    tasks: [{ id: 'MBRS-013', status: 'PARTIAL', depends_on: ['MBRS-012'] }],
    acceptance_cases: [{ id: 'MBRS-AT-013-01', task: 'MBRS-013', software_status: 'PARTIAL',
      live_status: 'NOT_RUN', owner_status: 'NOT_RUN', evidence_refs: [], requirement: '原验收标准' }] };
  const afterStatus = copy(beforeStatus), afterPlan = copy(beforePlan);
  afterStatus.mobileContractAdoption.implementationCommit = parent;
  afterStatus.mobileContractAdoption.report = 'reports/MBM-000_RESULT.md';
  for (const value of [afterStatus.mobileFrontloading20261008.mobileTasks[0], afterPlan.mobile_tasks[0]]) {
    value.implementation_commit = parent; value.report_path = 'reports/MBM-000_RESULT.md';
  }
  return { task, parent, beforeStatus, afterStatus, beforePlan, afterPlan,
    changes: [change('reports/MBM-000_RESULT.md'), change('project/STATUS.json'), change('project/POSTRUST_PLAN.json')] };
}

test('移动报告：独立000定位和精确父Source记账可准入，旧013保持', () => {
  const value = data();
  assert.equal(locateMobileReportTask(value.beforeStatus, value.beforePlan), task);
  assert.equal(classifyMobileReportChanges(value), true);
  assert.equal(value.afterStatus.currentPostRustTask, 'MBRS-013');
});
test('移动报告：缺失、重复或不同域定位器拒绝', () => {
  for (const edit of [v => { delete v.afterStatus.mobileContractAdoption; },
    v => { v.afterStatus.secondAdoption = copy(v.afterStatus.mobileContractAdoption); },
    v => { v.afterStatus.mobileFrontloading20261008.mobileTasks.push(copy(v.afterPlan.mobile_tasks[0])); },
    v => { v.afterPlan.mobile_tasks.push(copy(v.afterPlan.mobile_tasks[0])); },
    v => { v.afterPlan.execution_schedule.current_task = 'MBM-001'; },
    v => { v.afterStatus.mobileFrontloading20261008.currentTask = 'MBRS-013'; },
    v => { v.afterStatus.mobileContractAdoption.branch = 'codex/other'; },
    v => { v.afterPlan.mobile_tasks[0].scope_ref = 'wrong'; }]) {
    const value = data(); edit(value); assert.equal(classifyMobileReportChanges(value), false);
  }
});
test('移动报告：父Source必须同时绑定独立叶和两份当前行', () => {
  for (const edit of [v => { v.afterStatus.mobileContractAdoption.implementationCommit = base; },
    v => { delete v.afterStatus.mobileFrontloading20261008.mobileTasks[0].implementation_commit; },
    v => { v.afterPlan.mobile_tasks[0].implementation_commit = base; },
    v => { v.parent = 'unknown'; }]) {
    const value = data(); edit(value); assert.equal(classifyMobileReportChanges(value), false);
  }
});
test('移动报告：已测范围、对端和真实层不得在R提交升层', () => {
  for (const field of ['software', 'productionApp', 'peerAdoption', 'pairedAdoptionComplete',
    'realServiceDeviceAudioOwner', 'state', 'ownerRepeatedApprovalRequired', 'canonical', 'gateBudgets']) {
    const value = data(); value.afterStatus.mobileContractAdoption[field] = 'PASS';
    assert.equal(classifyMobileReportChanges(value), false, field);
  }
});
test('移动报告：未知字段、许可、预算、基线和输入身份变化拒绝', () => {
  for (const edit of [v => { v.afterStatus.mobileContractAdoption.unknownAuthority = true; },
    v => { v.afterStatus.mobileContractAdoption.baseSha = parent; },
    v => { v.afterStatus.mobileContractAdoption.scope = 'docs/other.json'; },
    v => { v.afterStatus.mobileContractAdoption.gateBudgets.totalTimeoutMs++; },
    v => { v.afterStatus.mobileContractAdoption.iosSourceSha = parent; }]) {
    const value = data(); edit(value); assert.equal(classifyMobileReportChanges(value), false);
  }
});
test('移动报告：其它移动任务、旧账、原验收文字及所有证据状态冻结', () => {
  for (const edit of [v => { v.afterPlan.mobile_tasks[1].status = 'PASS'; },
    v => { v.afterStatus.original.software = 'changed'; },
    v => { v.afterPlan.tasks[0].depends_on = []; },
    v => { v.afterPlan.acceptance_cases[0].requirement = '放宽'; },
    v => { v.afterPlan.acceptance_cases[0].software_status = 'PASS'; },
    v => { v.afterPlan.acceptance_cases[0].live_status = 'PASS'; },
    v => { v.afterPlan.acceptance_cases[0].owner_status = 'PASS'; },
    v => { v.afterPlan.acceptance_cases[0].evidence_refs.push('新证据'); },
    v => { v.afterStatus.mobileFrontloading20261008.nextTask = 'MBM-004'; }]) {
    const value = data(); edit(value); assert.equal(classifyMobileReportChanges(value), false);
  }
});
test('移动报告：仅有限报告和evidence文档路径准入', () => {
  const value = data(); value.changes.push({ ...change('docs/postrust/MBM-000/evidence/source_ci.json'),
    status: 'A', oldMode: '000000' });
  assert.equal(classifyMobileReportChanges(value), true);
  for (const name of ['packages/contracts/mobile/openapi.json', 'packages/contracts/mobile/fixtures/manifest.json',
    'packages/contracts/src/mobile-common.ts', 'docs/postrust/MBM-000/INPUT_LOCK.json',
    'docs/postrust/MBM-000/ADOPTION.json', 'docs/postrust/MBM-000/TEST_SCOPE.json',
    'tasks/MBM-000_MOBILE_CONTRACT_ADOPTION.md', 'pnpm-lock.yaml', 'AGENTS.md',
    '.github/workflows/verify.yml', 'reports/MBRS-013_RESULT.md', 'reports/MBM-001_RESULT.md']) {
    const invalid = data(); invalid.changes.push(change(name));
    assert.equal(classifyMobileReportChanges(invalid), false, name);
  }
});
test('移动报告：无报告、删除、rename、链接、可执行或错误新增模式拒绝', () => {
  for (const edit of [v => { v.changes.shift(); }, v => { v.changes = []; },
    v => { v.changes[0].status = 'D'; }, v => { v.changes[0].status = 'R'; },
    v => { v.changes[0].newMode = '120000'; }, v => { v.changes[0].newMode = '100755'; },
    v => { v.changes[0].oldMode = '120000'; },
    v => { v.changes[0].status = 'A'; v.changes[0].oldMode = '100644'; }]) {
    const value = data(); edit(value); assert.equal(classifyMobileReportChanges(value), false);
  }
});

function ciData(source = parent) {
  const paths = ['verify', 'security', 'rust-core', 'electron-e2e'].map(name => '.github/workflows/' + name + '.yml');
  const steps = [
    ['Verify platform-independent workspace (typecheck, unit tests, build; no Electron)',
      'Production dependency audit', 'MBRS013 本地目录迁移 Gate', 'MBM000 移动合同双端采纳 Gate'],
    ['Run directed platform-independent security tests (no Electron)'], ['验证实际 Rust 与 TypeScript 边界'],
    ['Electron startup, crash/restart, safeStorage vault and credential recovery gates',
      'Electron end-to-end flow (Playwright, production build)'] ];
  const runs = paths.map((file, i) => ({ id: i + 1, path: file, head_sha: source, head_branch: branch,
    event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1,
    repository: { id: 99 }, head_repository: { id: 99 } }));
  const labels = [['verify-' + source], [], ['rust-core-ubuntu-latest-' + source, 'rust-core-macos-latest-' + source],
    ['electron-e2e-' + source, 'rust-host-compiled-' + source]];
  const proofs = runs.map((run, i) => ({ runId: run.id,
    jobs: Array.from({ length: i === 2 || i === 3 ? 2 : 1 }, (_, j) => ({ id: run.id * 100 + j,
      run_id: run.id, head_sha: source, status: 'completed', conclusion: 'success',
      steps: steps[i].map(name => ({ name, status: 'completed', conclusion: 'success' })) })),
    artifacts: labels[i].map((name, j) => ({ id: run.id * 10 + j, name, expired: false,
      digest: 'sha256:' + 'd'.repeat(64), expires_at: '2099-01-01T00:00:00Z',
      workflow_run: { id: run.id, head_sha: source, repository_id: 99, head_repository_id: 99 } })) }));
  return { task, parent: source, repositoryId: 99, branch, runs, proofs, now: Date.parse('2026-10-09T00:00:00Z') };
}
test('移动报告：同一Source四工作流六job及自己的成功Gate可复用', () => {
  const value = ciData(); assert.equal(value.proofs.flatMap(p => p.jobs).length, 6);
  assert.equal(validateMobileParentCi(value), true);
});
test('移动报告：只有旧013或移动producer缺失、skipped、失败、重复均拒绝', () => {
  for (const edit of [v => { v.proofs[0].jobs[0].steps.pop(); },
    v => { v.proofs[0].jobs[0].steps.at(-1).conclusion = 'skipped'; },
    v => { v.proofs[0].jobs[0].steps.at(-1).conclusion = 'failure'; },
    v => { v.proofs[0].jobs[0].steps.at(-1).status = 'in_progress'; },
    v => { v.proofs[0].jobs[0].steps.push(copy(v.proofs[0].jobs[0].steps.at(-1))); },
    v => { v.proofs.push(copy(v.proofs[0])); }]) {
    const value = ciData(); edit(value); assert.equal(validateMobileParentCi(value), false);
  }
});
test('移动报告：错Source、分支、仓库、事件、重跑或失败job不能借producer', () => {
  for (const edit of [v => { v.runs[0].head_sha = base; }, v => { v.runs[0].head_branch = 'wrong'; },
    v => { v.runs[0].repository.id = 100; }, v => { v.runs[0].event = 'workflow_dispatch'; },
    v => { v.runs[0].run_attempt = 2; }, v => { v.proofs[1].jobs[0].conclusion = 'failure'; },
    v => { v.proofs[2].jobs.pop(); }, v => { v.task = 'MBM-001'; }]) {
    const value = ciData(); edit(value); assert.equal(validateMobileParentCi(value), false);
  }
});
test('移动报告：Source制品平台digest、期限和所有producer身份仍须完整', () => {
  for (const edit of [v => { v.proofs[0].artifacts = []; },
    v => { v.proofs[0].artifacts[0].digest = null; },
    v => { v.proofs[0].artifacts[0].expired = true; },
    v => { v.proofs[0].artifacts[0].workflow_run.head_sha = base; },
    v => { v.proofs[0].artifacts[0].workflow_run.id = 999; },
    v => { v.proofs[3].artifacts[0].workflow_run.head_repository_id = 100; }]) {
    const value = ciData(); edit(value); assert.equal(validateMobileParentCi(value), false);
  }
});

test('移动报告：真实Git选独立000路径，失败不能退回旧013报告准入', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mbm000-report-only-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git(['init', '-b', branch]); git(['config', 'user.name', '合成测试']);
  git(['config', 'user.email', 'synthetic@example.invalid']);
  for (const name of ['project', 'reports']) mkdirSync(path.join(directory, name));
  const initial = data();
  writeFileSync(path.join(directory, 'project/STATUS.json'), JSON.stringify(initial.beforeStatus));
  writeFileSync(path.join(directory, 'project/POSTRUST_PLAN.json'), JSON.stringify(initial.beforePlan));
  git(['add', '.']); git(['commit', '-m', '合成Source']); const actualParent = git(['rev-parse', 'HEAD']);
  initial.afterStatus.mobileContractAdoption.implementationCommit = actualParent;
  initial.afterStatus.mobileFrontloading20261008.mobileTasks[0].implementation_commit = actualParent;
  initial.afterPlan.mobile_tasks[0].implementation_commit = actualParent;
  writeFileSync(path.join(directory, 'project/STATUS.json'), JSON.stringify(initial.afterStatus));
  writeFileSync(path.join(directory, 'project/POSTRUST_PLAN.json'), JSON.stringify(initial.afterPlan));
  writeFileSync(path.join(directory, 'reports/MBM-000_RESULT.md'), '合成移动报告');
  git(['add', '.']); git(['commit', '-m', '合成R']);
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'push',
    GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'synthetic/repo', GITHUB_REF_NAME: branch,
    GITHUB_SHA: git(['rev-parse', 'HEAD']) };
  const complete = ciData(actualParent);
  const api = async route => {
    if (route === '') return { id: 99, private: false, full_name: 'synthetic/repo' };
    if (route.startsWith('/actions/runs?')) return { total_count: 4, workflow_runs: complete.runs };
    const id = Number(/\/runs\/(\d+)/u.exec(route)?.[1]), proof = complete.proofs.find(value => value.runId === id);
    return route.includes('/jobs?') ? { total_count: proof.jobs.length, jobs: proof.jobs }
      : { total_count: proof.artifacts.length, artifacts: proof.artifacts };
  };
  const result = await inspectReportOnly(env, directory, api);
  assert.equal(result.mode, 'report-only'); assert.equal(result.task, task);
  assert.equal(result.parentSourceSha, actualParent); assert.equal(result.artifactContentDownloaded, false);
  initial.afterStatus.mobileContractAdoption.pairedAdoptionComplete = true;
  writeFileSync(path.join(directory, 'project/STATUS.json'), JSON.stringify(initial.afterStatus));
  git(['add', 'project/STATUS.json']); git(['commit', '--amend', '--no-edit']); env.GITHUB_SHA = git(['rev-parse', 'HEAD']);
  let calls = 0;
  const rejected = await inspectReportOnly(env, directory, async () => { calls++; return {}; });
  assert.equal(rejected.mode, 'full'); assert.equal(rejected.reason, 'SOURCE_SCOPE_OR_AUTHORITY_CHANGED');
  assert.equal(calls, 0);
});
