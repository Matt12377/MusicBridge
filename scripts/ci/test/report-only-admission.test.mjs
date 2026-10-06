import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyReportChanges, parseRawDiff, validateParentCi, inspectReportOnly } from '../report-only-admission.mjs';

const parent = 'a'.repeat(40), task = 'MBRS-005';
const copy = value => structuredClone(value);
const change = name => ({ path: name, status: 'M', oldMode: '100644', newMode: '100644' });
function data() {
  const frozen = { task, state: 'SOFTWARE_PASS', implementationCommit: null, reportCommit: null,
    ownerAuthorization: '连续开发到017', sourceFileWrites: 'OFF', g0Decision: 'FINITE',
    realServices: 'NOT_RUN', ownerAcceptance: 'NOT_RUN', validation: { pass: 10 } };
  const beforeStatus = { currentPostRustTask: task, lane: frozen, previous: { task: 'MBRS-004', state: 'SOFTWARE_PASS' } };
  const afterStatus = copy(beforeStatus); afterStatus.lane.implementationCommit = parent; afterStatus.lane.report = 'reports/MBRS-005_RESULT.md';
  const beforePlan = { tasks: [{ id: task, status: 'SOFTWARE_PASS', implementation_commit: null, depends_on: ['MBRS-002'], goal: '原文件' }],
    acceptance_cases: [{ id: 'MBRS-AT-005-06', task, kind: 'live_roon', requirement: '实际Core', software_status: 'PARTIAL', live_status: 'NOT_RUN', owner_status: 'NOT_RUN', evidence_refs: [] }] };
  const afterPlan = copy(beforePlan); afterPlan.tasks[0].implementation_commit = parent;
  return { task, parent, beforeStatus, afterStatus, beforePlan, afterPlan,
    changes: [change('reports/MBRS-005_RESULT.md'), change('project/STATUS.json'), change('project/POSTRUST_PLAN.json')] };
}
test('报告轻量：精确父源提交、有限状态字段与报告路径准入', () => assert.equal(classifyReportChanges(data()), true));
for (const field of ['ownerAuthorization', 'sourceFileWrites', 'g0Decision', 'realServices', 'ownerAcceptance', 'validation']) {
  test('报告轻量：改变权限或已测范围字段拒绝 ' + field, () => {
    const value = data(); value.afterStatus.lane[field] = '新值'; assert.equal(classifyReportChanges(value), false);
  });
}
test('报告轻量：无父源绑定或其它任务变化拒绝', () => {
  for (const edit of [value => { value.afterStatus.lane.implementationCommit = 'b'.repeat(40); },
    value => { value.afterStatus.previous.state = 'PASS'; }, value => { value.afterStatus.lane.newAuthority = true; }]) {
    const value = data(); edit(value); assert.equal(classifyReportChanges(value), false);
  }
});
test('报告轻量：原验收文字、kind、软件/live/Owner状态和依赖改变拒绝', () => {
  for (const field of ['requirement', 'kind', 'software_status', 'live_status', 'owner_status']) {
    const value = data(); value.afterPlan.acceptance_cases[0][field] = 'PASS'; assert.equal(classifyReportChanges(value), false);
  }
  const value = data(); value.afterPlan.tasks[0].depends_on = []; assert.equal(classifyReportChanges(value), false);
});
test('报告轻量：产品、fixture、锁文件、任务、权限说明和workflow路径拒绝', () => {
  for (const name of ['packages/bridge-core/src/a.ts', 'packages/bridge-core/test/fixture.json', 'pnpm-lock.yaml',
    'tasks/MBRS-005_LOCAL_FILE_GATEWAY.md', 'docs/postrust/MBRS-005/NETWORK_ACCESS.md',
    'docs/postrust/MBRS-005/EXECUTION_SCOPE.json', '.github/workflows/verify.yml', 'AGENTS.md']) {
    const value = data(); value.changes.push(change(name)); assert.equal(classifyReportChanges(value), false);
  }
});
test('报告轻量：没有报告、删除、重命名、链接或可执行文档拒绝', () => {
  for (const edit of [value => { value.changes.shift(); },
    value => { value.changes[0].status = 'D'; }, value => { value.changes[0].status = 'R'; },
    value => { value.changes[0].newMode = '120000'; }, value => { value.changes[0].newMode = '100755'; }]) {
    const value = data(); edit(value); assert.equal(classifyReportChanges(value), false);
  }
});
test('报告轻量：raw diff按NUL解析，未知格式拒绝', () => {
  assert.deepEqual(parseRawDiff(':100644 100644 123abcd 456abcd M\0reports/MBRS-005_RESULT.md\0'), [change('reports/MBRS-005_RESULT.md')]);
  assert.throws(() => parseRawDiff(':100644 100644 a b R100\0old\0new\0'));
});

const paths = ['verify', 'security', 'rust-core', 'electron-e2e'].map(name => '.github/workflows/' + name + '.yml');
const names = [
  ['Verify platform-independent workspace (typecheck, unit tests, build; no Electron)', 'MBRS005 本地文件网关与资源租约 Gate', 'Production dependency audit'],
  ['Run directed platform-independent security tests (no Electron)'],
  ['验证实际 Rust 与 TypeScript 边界'],
  ['Electron startup, crash/restart, safeStorage vault and credential recovery gates', 'Electron end-to-end flow (Playwright, production build)'],
];
function ciData() {
  const runs = paths.map((file, i) => ({ id: i + 1, path: file, status: 'completed', conclusion: 'success',
    run_attempt: 1, event: 'push', head_sha: parent, head_branch: 'codex/test',
    repository: { id: 99 }, head_repository: { id: 99 } }));
  const artifacts = (run, labels) => labels.map((name, i) => ({ id: run.id * 10 + i, name, digest: 'sha256:' + 'd'.repeat(64),
    expired: false, expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: run.id, head_sha: parent, repository_id: 99, head_repository_id: 99 } }));
  const proofs = runs.map((run, i) => ({ runId: run.id, jobs: Array.from({ length: i === 2 ? 2 : 1 }, (_, j) => ({
    id: run.id * 100 + j, run_id: run.id, head_sha: parent, status: 'completed', conclusion: 'success',
    steps: names[i].map(name => ({ name, conclusion: 'success' })),
  })), artifacts: artifacts(run, i === 0 ? ['verify-' + parent] : i === 2
    ? ['rust-core-ubuntu-latest-' + parent, 'rust-core-macos-latest-' + parent]
    : i === 3 ? ['electron-e2e-' + parent, 'rust-host-compiled-' + parent] : []) }));
  return { task, repositoryId: 99, parent, branch: 'codex/test', runs, proofs, now: Date.parse('2026-10-06T00:00:00Z') };
}
test('报告轻量：真实产品步骤、完整job和对应digest元数据可复用，security无需artifact', () => assert.equal(validateParentCi(ciData()), true));
test('报告轻量：后续任务不能复用只有旧任务Gate的父源结果', () => {
  const value = ciData(); value.task = 'MBRS-006'; assert.equal(validateParentCi(value), false);
  value.proofs[0].jobs[0].steps.push({ name: 'MBRS006 播放器接线 Gate', conclusion: 'success' });
  assert.equal(validateParentCi(value), true);
  value.proofs[0].jobs[0].steps.at(-1).conclusion = 'skipped'; assert.equal(validateParentCi(value), false);
});
test('报告轻量：旧源、fork、其它分支、非push、未知或重试终态拒绝', () => {
  for (const edit of [run => { run.head_sha = 'b'.repeat(40); }, run => { run.head_repository.id = 100; },
    run => { run.head_branch = 'other'; }, run => { run.event = 'workflow_dispatch'; },
    run => { run.conclusion = null; }, run => { run.run_attempt = 2; }]) {
    const value = ciData(); edit(value.runs[0]); assert.equal(validateParentCi(value), false);
  }
});
test('报告轻量：失败job或真正产品Gate skipped拒绝，防止报告继承报告', () => {
  for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
    const value = ciData(); value.proofs[0].jobs[0].steps[0].conclusion = conclusion; assert.equal(validateParentCi(value), false);
  }
  const value = ciData(); value.proofs[1].jobs[0].conclusion = 'failure'; assert.equal(validateParentCi(value), false);
});
test('报告轻量：缺Rust平台、同名多run、缺失或过期artifact拒绝', () => {
  for (const edit of [value => { value.proofs[2].jobs.pop(); }, value => { value.runs.push(copy(value.runs[0])); },
    value => { value.proofs[0].artifacts = []; }, value => { value.proofs[0].artifacts[0].expired = true; },
    value => { value.proofs[0].artifacts[0].expires_at = 'bad'; }]) {
    const value = ciData(); edit(value); assert.equal(validateParentCi(value), false);
  }
});
test('报告轻量：平台digest和producer任一身份错配均拒绝', () => {
  for (const edit of [item => { item.digest = null; }, item => { item.workflow_run.head_sha = 'b'.repeat(40); },
    item => { item.workflow_run.repository_id = 100; }, item => { item.workflow_run.id = 999; }]) {
    const value = ciData(); edit(value.proofs[0].artifacts[0]); assert.equal(validateParentCi(value), false);
  }
});

test('报告轻量：真实Git修改产品和API不可用均自然回退full', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mb-report-only-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git(['init', '-b', 'codex/test']); git(['config', 'user.name', '合成测试']); git(['config', 'user.email', 'synthetic@example.invalid']);
  const initial = data();
  for (const name of ['project', 'reports', 'packages/bridge-core/src']) mkdirSync(path.join(directory, name), { recursive: true });
  writeFileSync(path.join(directory, 'project/STATUS.json'), JSON.stringify(initial.beforeStatus));
  writeFileSync(path.join(directory, 'project/POSTRUST_PLAN.json'), JSON.stringify(initial.beforePlan));
  writeFileSync(path.join(directory, 'packages/bridge-core/src/a.ts'), 'export const a=1;\n');
  git(['add', '.']); git(['commit', '-m', '合成源码']); const actualParent = git(['rev-parse', 'HEAD']);
  initial.afterStatus.lane.implementationCommit = actualParent;
  initial.afterPlan.tasks[0].implementation_commit = actualParent;
  writeFileSync(path.join(directory, 'project/STATUS.json'), JSON.stringify(initial.afterStatus));
  writeFileSync(path.join(directory, 'project/POSTRUST_PLAN.json'), JSON.stringify(initial.afterPlan));
  writeFileSync(path.join(directory, 'reports/MBRS-005_RESULT.md'), '合成报告');
  git(['add', '.']); git(['commit', '-m', '合成报告']);
  const context = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'push',
    GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'synthetic/repo', GITHUB_REF_NAME: 'codex/test', GITHUB_SHA: git(['rev-parse', 'HEAD']) };
  const complete = JSON.parse(JSON.stringify(ciData()).replaceAll(parent, actualParent));
  const reused = await inspectReportOnly(context, directory, async route => {
    if (route === '') return { id: 99, private: false, full_name: 'synthetic/repo' };
    if (route.startsWith('/actions/runs?')) return { total_count: complete.runs.length, workflow_runs: complete.runs };
    const id = Number(/\/runs\/(\d+)/u.exec(route)?.[1]), proof = complete.proofs.find(item => item.runId === id);
    if (route.includes('/jobs?')) return { total_count: proof.jobs.length, jobs: proof.jobs };
    return { total_count: proof.artifacts.length, artifacts: proof.artifacts };
  });
  assert.equal(reused.mode, 'report-only'); assert.equal(reused.parentSourceSha, actualParent);
  assert.equal(reused.artifactContentDownloaded, false);
  let calls = 0;
  const unavailable = await inspectReportOnly(context, directory, async () => { calls++; throw new Error('403'); });
  assert.equal(unavailable.mode, 'full'); assert.equal(calls, 1);
  writeFileSync(path.join(directory, 'packages/bridge-core/src/a.ts'), 'export const a=2;\n');
  git(['add', '.']); git(['commit', '--amend', '--no-edit']); context.GITHUB_SHA = git(['rev-parse', 'HEAD']);
  calls = 0; const source = await inspectReportOnly(context, directory, async () => { calls++; return {}; });
  assert.equal(source.reason, 'SOURCE_SCOPE_OR_AUTHORITY_CHANGED'); assert.equal(calls, 0);
});
test('报告轻量：普通本机会话绝不访问GitHub API', async () => {
  const result = await inspectReportOnly({}, '.', async () => { throw new Error('不应调用'); });
  assert.equal(result.mode, 'full'); assert.equal(result.reason, 'NOT_PUBLIC_HOSTED_PUSH_CONTEXT');
});
