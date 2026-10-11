import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MBM004_BRANCH, MBM004_BASE, MBM004_SCOPE_PATH, MBM004_STATUS_PATH } from '../mbm004-admission.mjs';
import { classifyMobileContentReportChanges, locateMobileContentReportTask, validateMobileContentParentCi } from '../report-only-mbm004.mjs';
import { inspectReportOnly } from '../report-only-admission.mjs';
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
    run_id: run.id, head_sha: parent, status: 'completed', conclusion: 'success', steps: (i === 0
      ? j === 0 ? names[i].slice(0, 2) : names[i].slice(2) : j === 0 || i === 2 ? names[i] : [])
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

test('004实际producer逐job与proof配对，重复proof、错job拼step或非法时钟均拒收', () => {
  const mutations = [
    value => { value.proofs[3] = clone(value.proofs[0]); },
    value => { value.proofs[1].runId = value.proofs[0].runId; },
    value => { value.proofs[2].jobs[0].steps.push(...value.proofs[2].jobs[1].steps); value.proofs[2].jobs[1].steps = []; },
    value => { value.proofs[0].jobs[1].steps.push(value.proofs[0].jobs[0].steps.pop()); },
    value => { value.proofs[0].jobs[0].steps.push(...value.proofs[0].jobs[1].steps); value.proofs[0].jobs[1].steps = []; },
    value => { value.proofs[0].jobs[1].steps.push(clone(value.proofs[0].jobs[0].steps[0])); },
  ];
  for (const edit of mutations) {
    const value = ci(); edit(value); assert.equal(validateMobileContentParentCi(value), false);
  }
  for (const now of [NaN, Infinity, -Infinity, null, '2030-01-01']) {
    assert.equal(validateMobileContentParentCi({ ...ci(), now }), false);
  }
});

test('004真实临时Git报告：伪Scope、非固定Source父链及GIT_*别repo注入在API前闭合', async t => {
  const temporaryValue = process.env.TMPDIR ?? process.env.RUNNER_TEMP;
  assert.ok(temporaryValue && path.isAbsolute(temporaryValue), '本机由Root提供批准外置tmp，CI由runner提供私有临时根');
  const temporary = path.resolve(temporaryValue);
  assert.equal(realpathSync(temporary), temporary); assert.equal(lstatSync(temporary).isDirectory(), true);
  const owned = mkdtempSync(path.join(temporary, 'mbm004-report-actual-git-')); chmodSync(owned, 0o700);
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  const fixtureEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(fixtureEnvironment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  function repository(name, generic = false, changedScope = false) {
    const directory = path.join(owned, name); mkdirSync(directory, { mode: 0o700 });
    const git = args => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: directory, env: fixtureEnvironment, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 }).trim();
    git(['init', '--quiet', '--initial-branch=' + (generic ? 'codex/synthetic-decoy' : MBM004_BRANCH), '--object-format=sha1']);
    git(['config', 'user.name', 'Synthetic MBM004']); git(['config', 'user.email', 'synthetic@example.invalid']);
    const write = (relative, value) => {
      const file = path.join(directory, relative); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    };
    const initial = data(), status = generic ? { currentPostRustTask: 'MBRS-005', lane: {
      task: 'MBRS-005', state: 'SOFTWARE_PASS', implementationCommit: null, realServices: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' } }
      : initial.beforeStatus;
    const plan = generic ? { tasks: [{ id: 'MBRS-005', status: 'SOFTWARE_PASS', implementation_commit: null }],
      acceptance_cases: [{ id: 'synthetic-live', task: 'MBRS-005', live_status: 'NOT_RUN', evidence_refs: [] }] }
      : initial.beforePlan;
    write('project/STATUS.json', status); write('project/POSTRUST_PLAN.json', plan);
    const record = { task: 'MBM-004', branch: MBM004_BRANCH, baseSha: MBM004_BASE, scope: MBM004_SCOPE_PATH,
      software: 'PASSED', productionApp: 'NOT_RUN', realServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN', implementationCommit: null };
    if (!generic) {
      // 真Git对象来自这个私有repo；明确不具有781→479身份，不伪造exact-head成功Source。
      write(MBM004_STATUS_PATH, record); write(MBM004_SCOPE_PATH, { schema: 'musicbridge.mbm004.execution-scope.v1',
        task: 'MBM-004', branch: MBM004_BRANCH, baseSha: MBM004_BASE, frozen: true, files: [] });
    }
    git(['add', '.']); git(['commit', '--quiet', '-m', '合成未合格父对象']);
    git(['commit', '--quiet', '--allow-empty', '-m', '合成非固定Source']); const source = git(['rev-parse', 'HEAD']);
    const afterStatus = clone(status), afterPlan = clone(plan);
    if (generic) {
      afterStatus.lane.implementationCommit = source; afterPlan.tasks[0].implementation_commit = source;
    } else {
      afterStatus.mobileContentMultidevice.implementationCommit = source;
      for (const rows of [afterStatus.mobileFrontloading20261008.mobileTasks, afterPlan.mobile_tasks]) rows[0].implementation_commit = source;
      write(MBM004_STATUS_PATH, { ...record, implementationCommit: source });
      if (changedScope) write(MBM004_SCOPE_PATH, { task: 'MBM-004', frozen: false, forged: true });
    }
    write('project/STATUS.json', afterStatus); write('project/POSTRUST_PLAN.json', afterPlan);
    write('reports/' + (generic ? 'MBRS-005' : 'MBM-004') + '_RESULT.md', '合成未合格报告，不能复用源码结果。\n');
    git(['add', '.']); git(['commit', '--quiet', '-m', '合成报告']);
    const head = git(['rev-parse', 'HEAD']); assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '');
    return { directory, head, source, context: { ...fixtureEnvironment, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_EVENT_NAME: 'push', GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'synthetic/repo',
      GITHUB_REF_NAME: generic ? 'codex/synthetic-decoy' : MBM004_BRANCH, GITHUB_SHA: head } };
  }
  async function rejected(value, environment = value.context, expectedReason) {
    let calls = 0;
    const result = await inspectReportOnly(environment, value.directory, async () => { calls++; throw new Error('未合格Git不能调用API'); });
    assert.equal(result.mode, 'full'); assert.equal(result.productResultsReused, false); assert.equal(calls, 0);
    if (expectedReason) assert.equal(result.reason, expectedReason);
  }
  const wrongChain = repository('wrong-chain'), forgedScope = repository('forged-scope', false, true);
  await rejected(wrongChain, wrongChain.context, 'CONTENT_SOURCE_OR_SCOPE_NOT_EXACT');
  await rejected(forgedScope, forgedScope.context, 'SOURCE_SCOPE_OR_AUTHORITY_CHANGED');
  const decoy = repository('decoy', true);
  const redirects = [
    { GIT_DIR: path.join(decoy.directory, '.git'), GIT_WORK_TREE: decoy.directory },
    { GIT_DIR: path.join(decoy.directory, '.git'), GIT_WORK_TREE: decoy.directory,
      GIT_INDEX_FILE: path.join(decoy.directory, '.git/index'), GIT_OBJECT_DIRECTORY: path.join(decoy.directory, '.git/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy.directory, '.git/objects') },
    { GIT_DIR: path.join(decoy.directory, '.git'), GIT_WORK_TREE: decoy.directory, GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: decoy.directory },
  ];
  for (const redirect of redirects) {
    const saved = new Map(Object.keys(redirect).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, redirect);
      // GITHUB_SHA也诱导指向别repo；净化后必须以真实directory HEAD拒绝，不能进入旧任务API。
      await rejected(wrongChain, { ...wrongChain.context, ...redirect, GITHUB_SHA: decoy.head }, 'CHECKOUT_NOT_PINNED_CLEAN');
    } finally {
      for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
